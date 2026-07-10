import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  DESIGN_MATE_CHAT_LIMITS,
  assembleDesignMateChatWirePrompt,
  encodeDesignMateChatSseEvent,
  isDesignMateProviderError,
  makeDesignMateProviderError,
  snapshotValidDesignMateChatProviderChunk,
  snapshotValidDesignMateChatWireRequest,
  type DesignMateProviderError,
  type DesignMateProviderErrorCode,
} from "@openlogo/design-mate";
import {
  createDefaultRequestAuth,
  isValidRequestAuthIdentity,
  type RequestAuth,
} from "./auth";
import {
  DESIGN_MATE_SERVICE_VERSION,
  validateDesignMateServiceConfig,
  type DesignMateServiceConfig,
} from "./config";
import { createOpenAIResponsesTransport } from "./openai-responses";
import {
  createFixedWindowRateLimiter,
  type DesignMateServiceClock,
} from "./rate-limit";
import {
  isValidTransportId,
  type DesignMateModelTransport,
} from "./transport";

const HEALTH_ROUTE = "/health";
const CHAT_ROUTE = "/v1/design-mate/chat";
const UNKNOWN_ROUTE = "<unknown>";
const REQUEST_TIMEOUT_REASON = "request-timeout";
const UPSTREAM_TIMEOUT_REASON = "upstream-timeout";
const CLIENT_DISCONNECT_REASON = "client-disconnect";

type KnownRoute = typeof HEALTH_ROUTE | typeof CHAT_ROUTE;
type LoggedRoute = KnownRoute | typeof UNKNOWN_ROUTE;

export type DesignMateServiceLogEntry = {
  readonly requestId: string;
  readonly route: LoggedRoute;
  readonly status: number;
  readonly durationMs: number;
  readonly providerId?: string;
  readonly errorCode?: DesignMateProviderErrorCode;
};

export type DesignMateServiceLogger =
  | ((entry: DesignMateServiceLogEntry) => void)
  | {
      readonly log?: (entry: DesignMateServiceLogEntry) => void;
      readonly info?: (entry: DesignMateServiceLogEntry) => void;
    };

export type CreateDesignMateServiceOptions = {
  readonly config: DesignMateServiceConfig;
  readonly transport?: DesignMateModelTransport;
  readonly auth?: RequestAuth;
  readonly logger?: DesignMateServiceLogger;
  readonly clock?: DesignMateServiceClock;
};

type BodyReadResult =
  | {
      readonly type: "ok";
      readonly value: Buffer;
    }
  | {
      readonly type: "too-large" | "aborted" | "failed";
    };

class TransportStartError {
  readonly _tag = "TransportStartError";
  readonly cause: unknown;

  constructor(cause: unknown) {
    this.cause = cause;
  }
}

class InvalidTransportOutput {
  readonly _tag = "InvalidTransportOutput";
}

type ConcurrencyDecision =
  | {
      readonly allowed: true;
      readonly release: () => void;
    }
  | {
      readonly allowed: false;
      readonly reason: "global" | "subject";
    };

function createConcurrencyLimiter(
  maximumGlobal: number,
  maximumPerSubject: number,
): {
  readonly acquire: (subject: string) => ConcurrencyDecision;
} {
  let active = 0;
  const activeBySubject = new Map<string, number>();
  return {
    acquire: (subject) => {
      const subjectActive = activeBySubject.get(subject) ?? 0;
      if (subjectActive >= maximumPerSubject) {
        return Object.freeze({ allowed: false, reason: "subject" });
      }
      if (active >= maximumGlobal) {
        return Object.freeze({ allowed: false, reason: "global" });
      }

      active += 1;
      activeBySubject.set(subject, subjectActive + 1);
      let released = false;
      return Object.freeze({
        allowed: true,
        release: () => {
          if (released) {
            return;
          }
          released = true;
          active = Math.max(0, active - 1);
          const current = activeBySubject.get(subject) ?? 0;
          if (current <= 1) {
            activeBySubject.delete(subject);
          } else {
            activeBySubject.set(subject, current - 1);
          }
        },
      });
    },
  };
}

function now(clock: DesignMateServiceClock): number {
  try {
    const value = clock();
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function logRequest(
  logger: DesignMateServiceLogger | undefined,
  entry: DesignMateServiceLogEntry,
): void {
  if (!logger) {
    return;
  }
  try {
    const snapshot = Object.freeze({ ...entry });
    if (typeof logger === "function") {
      logger(snapshot);
    } else if (typeof logger.log === "function") {
      logger.log(snapshot);
    } else if (typeof logger.info === "function") {
      logger.info(snapshot);
    }
  } catch {
    // Logging is observational and must never affect request handling.
  }
}

function jsonHeaders(extra: OutgoingHttpHeaders = {}): OutgoingHttpHeaders {
  return {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: Readonly<Record<string, unknown>>,
  extraHeaders: OutgoingHttpHeaders = {},
): void {
  if (response.headersSent || response.destroyed) {
    return;
  }
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...jsonHeaders(extraHeaders),
    "content-length": Buffer.byteLength(body, "utf8"),
  });
  response.end(body);
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  extraHeaders: OutgoingHttpHeaders = {},
): void {
  sendJson(response, status, { error: { code, message } }, extraHeaders);
}

function routeFor(request: IncomingMessage): KnownRoute | null {
  const requestTarget = request.url;
  if (
    typeof requestTarget !== "string" ||
    requestTarget.length === 0 ||
    requestTarget.length > 8_192
  ) {
    return null;
  }
  try {
    const parsed = new URL(requestTarget, "http://design-mate.invalid");
    if (parsed.pathname === HEALTH_ROUTE) {
      return HEALTH_ROUTE;
    }
    if (parsed.pathname === CHAT_ROUTE) {
      return CHAT_ROUTE;
    }
  } catch {
    return null;
  }
  return null;
}

function requestOrigin(
  request: IncomingMessage,
  allowedOrigins: ReadonlySet<string>,
): string | undefined | null {
  const origin = request.headers.origin;
  if (origin === undefined) {
    return undefined;
  }
  if (
    typeof origin !== "string" ||
    origin.length > 2_048 ||
    !allowedOrigins.has(origin)
  ) {
    return null;
  }
  return origin;
}

function corsHeaders(origin: string | undefined): OutgoingHttpHeaders {
  return origin === undefined
    ? {}
    : {
        "access-control-allow-origin": origin,
        vary: "Origin",
      };
}

function parseRequestedHeaders(
  value: string | string[] | undefined,
): readonly string[] | null {
  if (value === undefined) {
    return [];
  }
  if (typeof value !== "string" || value.length > 1_024) {
    return null;
  }
  const headers = value
    .split(",")
    .map((header) => header.trim().toLowerCase());
  if (
    headers.some(
      (header) =>
        header.length === 0 ||
        !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(header),
    )
  ) {
    return null;
  }
  return headers;
}

function handlePreflight(
  request: IncomingMessage,
  response: ServerResponse,
  route: KnownRoute,
  origin: string | undefined,
): number {
  if (origin === undefined) {
    sendError(
      response,
      400,
      "invalid-preflight",
      "A CORS preflight origin is required.",
    );
    return 400;
  }
  const expectedMethod = route === CHAT_ROUTE ? "POST" : "GET";
  const requestedMethod = request.headers["access-control-request-method"];
  const requestedHeaders = parseRequestedHeaders(
    request.headers["access-control-request-headers"],
  );
  const allowedHeaders =
    route === CHAT_ROUTE
      ? new Set(["authorization", "content-type"])
      : new Set<string>();
  if (
    requestedMethod !== expectedMethod ||
    requestedHeaders === null ||
    requestedHeaders.some((header) => !allowedHeaders.has(header))
  ) {
    sendError(
      response,
      400,
      "invalid-preflight",
      "The CORS preflight request is invalid.",
      corsHeaders(origin),
    );
    return 400;
  }

  response.writeHead(204, {
    ...corsHeaders(origin),
    "access-control-allow-methods": expectedMethod,
    ...(route === CHAT_ROUTE
      ? {
          "access-control-allow-headers": "Authorization, Content-Type",
        }
      : {}),
    "access-control-max-age": "600",
    "cache-control": "no-store",
    "content-length": "0",
  });
  response.end();
  return 204;
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  return (
    typeof value === "string" &&
    /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(value)
  );
}

function exceedsJsonDepth(value: string, maximumDepth: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > maximumDepth) {
        return true;
      }
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
  return false;
}

function readRequestBody(
  request: IncomingMessage,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<BodyReadResult> {
  const contentLength = request.headers["content-length"];
  if (
    contentLength !== undefined &&
    (typeof contentLength !== "string" ||
      !/^(?:0|[1-9]\d*)$/.test(contentLength))
  ) {
    request.resume();
    return Promise.resolve({ type: "failed" });
  }
  if (
    typeof contentLength === "string" &&
    Number(contentLength) > maximumBytes
  ) {
    request.resume();
    return Promise.resolve({ type: "too-large" });
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("aborted", onAborted);
      request.removeListener("error", onError);
      signal.removeEventListener("abort", onSignalAbort);
    };
    const finish = (result: BodyReadResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += bytes.byteLength;
      if (total > maximumBytes) {
        request.resume();
        finish({ type: "too-large" });
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      finish({ type: "ok", value: Buffer.concat(chunks, total) });
    };
    const onAborted = (): void => {
      finish({ type: "aborted" });
    };
    const onError = (): void => {
      finish({ type: "failed" });
    };
    const onSignalAbort = (): void => {
      request.resume();
      finish({ type: "aborted" });
    };

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
    signal.addEventListener("abort", onSignalAbort, { once: true });
    if (signal.aborted) {
      onSignalAbort();
    } else {
      request.resume();
    }
  });
}

function awaitWithSignal<T>(
  value: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("aborted"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (!settled) {
        settled = true;
        reject(new Error("aborted"));
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void value.then(
      (result) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        }
      },
      (cause: unknown) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(cause);
        }
      },
    );
  });
}

function writeSseFrame(
  response: ServerResponse,
  frame: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed || response.writableEnded) {
    return Promise.reject(new Error("closed"));
  }
  let accepted: boolean;
  try {
    accepted = response.write(frame);
  } catch {
    return Promise.reject(new Error("closed"));
  }
  if (accepted) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      response.removeListener("drain", onDrain);
      response.removeListener("close", onClose);
      response.removeListener("error", onClose);
      signal.removeEventListener("abort", onClose);
    };
    const settle = (success: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (success) {
        resolve();
      } else {
        reject(new Error("closed"));
      }
    };
    const onDrain = (): void => {
      settle(true);
    };
    const onClose = (): void => {
      settle(false);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onClose);
    signal.addEventListener("abort", onClose, { once: true });
  });
}

async function* streamWithAbort<T>(
  stream: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T, void, void> {
  const iterator = stream[Symbol.asyncIterator]();
  let finished = false;
  try {
    while (true) {
      const result = await awaitWithSignal(
        Promise.resolve(iterator.next()),
        signal,
      );
      if (result.done) {
        finished = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!finished && typeof iterator.return === "function") {
      try {
        void Promise.resolve(iterator.return()).catch(() => undefined);
      } catch {
        // A hostile transport may throw while cancellation is requested.
      }
    }
  }
}

function staticErrorMessage(code: DesignMateProviderErrorCode): string {
  switch (code) {
    case "rate-limited":
      return "The Design Mate model provider is rate limited.";
    case "invalid-request":
      return "The Design Mate model provider rejected the request.";
    case "invalid-chat-response":
    case "invalid-review":
      return "The Design Mate model provider returned an invalid response.";
    case "cancelled":
      return "The Design Mate model request was cancelled.";
    case "provider-failed":
      return "The Design Mate model provider could not complete the request.";
  }
}

function sanitizeTransportFailure(
  providerId: string,
  cause: unknown,
  signal: AbortSignal,
): DesignMateProviderError {
  if (
    signal.reason === REQUEST_TIMEOUT_REASON ||
    signal.reason === UPSTREAM_TIMEOUT_REASON
  ) {
    return makeDesignMateProviderError(
      providerId,
      "The Design Mate model request timed out.",
      { code: "provider-failed", retryable: true },
    );
  }
  if (signal.aborted) {
    return makeDesignMateProviderError(
      providerId,
      staticErrorMessage("cancelled"),
      { code: "cancelled", retryable: false },
    );
  }
  if (cause instanceof InvalidTransportOutput) {
    return makeDesignMateProviderError(
      providerId,
      staticErrorMessage("invalid-chat-response"),
      { code: "invalid-chat-response", retryable: false },
    );
  }
  try {
    if (isDesignMateProviderError(cause)) {
      const code =
        cause.code === "invalid-review"
          ? "invalid-chat-response"
          : cause.code;
      return makeDesignMateProviderError(
        providerId,
        staticErrorMessage(code),
        { code, retryable: cause.retryable },
      );
    }
  } catch {
    // Hostile transport errors fall through to a static failure.
  }
  return makeDesignMateProviderError(
    providerId,
    staticErrorMessage("provider-failed"),
    { code: "provider-failed", retryable: true },
  );
}

function writeTerminalFailure(
  response: ServerResponse,
  error: DesignMateProviderError,
): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  try {
    response.end(
      encodeDesignMateChatSseEvent({
        type: "failed",
        error,
      }),
    );
  } catch {
    response.destroy();
  }
}

function timeoutResponse(
  response: ServerResponse,
  reason: unknown,
  headers: OutgoingHttpHeaders,
): number {
  if (reason === REQUEST_TIMEOUT_REASON) {
    sendError(
      response,
      408,
      "request-timeout",
      "The Design Mate request timed out.",
      headers,
    );
    return 408;
  }
  return 499;
}

export function createDesignMateService(
  options: CreateDesignMateServiceOptions,
): Server {
  const config = validateDesignMateServiceConfig(options.config, {
    allowEphemeralPort: true,
    hasInjectedAuth: options.auth !== undefined,
    requireProvider: options.transport === undefined,
  });
  const transport =
    options.transport ??
    (config.provider
      ? createOpenAIResponsesTransport(config.provider)
      : undefined);
  if (
    !transport ||
    !isValidTransportId(transport.id) ||
    typeof transport.stream !== "function"
  ) {
    throw new TypeError("A valid Design Mate model transport is required.");
  }
  const auth = options.auth ?? createDefaultRequestAuth(config);
  if (!auth || typeof auth.authenticate !== "function") {
    throw new TypeError("A valid request auth implementation is required.");
  }
  const clock = options.clock ?? Date.now;
  if (typeof clock !== "function") {
    throw new TypeError("A valid service clock is required.");
  }
  const limiter = createFixedWindowRateLimiter(
    config.rateLimitRequestsPerMinute,
    clock,
  );
  const concurrencyLimiter = createConcurrencyLimiter(
    config.maxConcurrentRequests,
    config.maxConcurrentRequestsPerSubject,
  );
  const allowedOrigins = new Set(config.allowedOrigins);

  const server = createServer(
    {
      maxHeaderSize: 16 * 1_024,
      requireHostHeader: true,
    },
    (request, response) => {
      const requestId = randomUUID();
      const startedAt = now(clock);
      const route = routeFor(request);
      const loggedRoute: LoggedRoute = route ?? UNKNOWN_ROUTE;
      let logStatus = 500;
      let providerId: string | undefined;
      let errorCode: DesignMateProviderErrorCode | undefined;
      let releaseConcurrencyLease: (() => void) | undefined;
      response.setHeader("x-request-id", requestId);

      const requestController = new AbortController();
      const requestTimer = setTimeout(() => {
        requestController.abort(REQUEST_TIMEOUT_REASON);
      }, config.requestTimeoutMs);
      requestTimer.unref();
      const onClientAborted = (): void => {
        if (!requestController.signal.aborted) {
          requestController.abort(CLIENT_DISCONNECT_REASON);
        }
      };
      const onResponseClose = (): void => {
        if (
          !response.writableEnded &&
          !requestController.signal.aborted
        ) {
          requestController.abort(CLIENT_DISCONNECT_REASON);
        }
      };
      request.once("aborted", onClientAborted);
      response.once("close", onResponseClose);

      const handle = async (): Promise<void> => {
        if (!route) {
          logStatus = 404;
          sendError(
            response,
            404,
            "not-found",
            "The requested route was not found.",
          );
          return;
        }

        const origin = requestOrigin(request, allowedOrigins);
        if (origin === null) {
          logStatus = 403;
          sendError(
            response,
            403,
            "origin-not-allowed",
            "The request origin is not allowed.",
          );
          return;
        }
        const responseCorsHeaders = corsHeaders(origin);

        if (request.method === "OPTIONS") {
          logStatus = handlePreflight(
            request,
            response,
            route,
            origin,
          );
          return;
        }

        const allowedMethod = route === HEALTH_ROUTE ? "GET" : "POST";
        if (request.method !== allowedMethod) {
          logStatus = 405;
          sendError(
            response,
            405,
            "method-not-allowed",
            "The request method is not allowed.",
            {
              ...responseCorsHeaders,
              allow: `${allowedMethod}, OPTIONS`,
            },
          );
          return;
        }

        if (route === HEALTH_ROUTE) {
          logStatus = 200;
          sendJson(
            response,
            200,
            {
              status: "ok",
              version: DESIGN_MATE_SERVICE_VERSION,
            },
            responseCorsHeaders,
          );
          return;
        }

        let identity: unknown;
        try {
          identity = await awaitWithSignal(
            Promise.resolve(
              auth.authenticate({
                request,
                ...(request.socket.remoteAddress === undefined
                  ? {}
                  : { remoteAddress: request.socket.remoteAddress }),
                signal: requestController.signal,
              }),
            ),
            requestController.signal,
          );
        } catch {
          if (requestController.signal.aborted) {
            logStatus = timeoutResponse(
              response,
              requestController.signal.reason,
              responseCorsHeaders,
            );
          } else {
            logStatus = 500;
            sendError(
              response,
              500,
              "authentication-failed",
              "Request authentication could not be completed.",
              responseCorsHeaders,
            );
          }
          return;
        }
        if (!isValidRequestAuthIdentity(identity)) {
          logStatus = 401;
          sendError(
            response,
            401,
            "unauthorized",
            "Authentication is required.",
            {
              ...responseCorsHeaders,
              ...(config.serviceToken === undefined
                ? {}
                : { "www-authenticate": "Bearer" }),
            },
          );
          return;
        }

        const rateLimit = limiter.take(identity.subject);
        if (!rateLimit.allowed) {
          logStatus = 429;
          sendError(
            response,
            429,
            "rate-limited",
            "Too many Design Mate requests.",
            {
              ...responseCorsHeaders,
              "retry-after": String(rateLimit.retryAfterSeconds),
            },
          );
          return;
        }

        const concurrency = concurrencyLimiter.acquire(identity.subject);
        if (!concurrency.allowed) {
          request.resume();
          const subjectSaturated = concurrency.reason === "subject";
          logStatus = subjectSaturated ? 429 : 503;
          sendError(
            response,
            logStatus,
            subjectSaturated
              ? "subject-concurrency-limited"
              : "service-concurrency-limited",
            subjectSaturated
              ? "Too many concurrent Design Mate requests for this subject."
              : "The Design Mate service is temporarily at capacity.",
            {
              ...responseCorsHeaders,
              "retry-after": "1",
            },
          );
          return;
        }
        releaseConcurrencyLease = concurrency.release;

        if (!isJsonContentType(request.headers["content-type"])) {
          logStatus = 415;
          sendError(
            response,
            415,
            "unsupported-media-type",
            "The request content type must be application/json.",
            responseCorsHeaders,
          );
          return;
        }
        const contentEncoding = request.headers["content-encoding"];
        if (
          contentEncoding !== undefined &&
          (typeof contentEncoding !== "string" ||
            contentEncoding.toLowerCase() !== "identity")
        ) {
          logStatus = 415;
          sendError(
            response,
            415,
            "unsupported-content-encoding",
            "Compressed request bodies are not accepted.",
            responseCorsHeaders,
          );
          return;
        }

        const body = await readRequestBody(
          request,
          config.maxBodyBytes,
          requestController.signal,
        );
        if (body.type === "too-large") {
          logStatus = 413;
          sendError(
            response,
            413,
            "request-too-large",
            "The Design Mate request body is too large.",
            responseCorsHeaders,
          );
          return;
        }
        if (body.type !== "ok") {
          if (requestController.signal.aborted) {
            logStatus = timeoutResponse(
              response,
              requestController.signal.reason,
              responseCorsHeaders,
            );
          } else {
            logStatus = 400;
            sendError(
              response,
              400,
              "invalid-request-body",
              "The Design Mate request body could not be read.",
              responseCorsHeaders,
            );
          }
          return;
        }

        let bodyText: string;
        try {
          bodyText = new TextDecoder("utf-8", { fatal: true }).decode(
            body.value,
          );
        } catch {
          logStatus = 400;
          sendError(
            response,
            400,
            "invalid-json",
            "The request body is not valid JSON.",
            responseCorsHeaders,
          );
          return;
        }
        if (exceedsJsonDepth(bodyText, config.maxJsonDepth)) {
          logStatus = 400;
          sendError(
            response,
            400,
            "json-too-deep",
            "The request JSON exceeds the nesting limit.",
            responseCorsHeaders,
          );
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          logStatus = 400;
          sendError(
            response,
            400,
            "invalid-json",
            "The request body is not valid JSON.",
            responseCorsHeaders,
          );
          return;
        }
        const wireRequest =
          snapshotValidDesignMateChatWireRequest(parsed);
        if (!wireRequest) {
          logStatus = 400;
          sendError(
            response,
            400,
            "invalid-design-mate-request",
            "The Design Mate chat request is invalid.",
            responseCorsHeaders,
          );
          return;
        }

        let prompt;
        try {
          prompt = assembleDesignMateChatWirePrompt(wireRequest);
        } catch {
          logStatus = 500;
          sendError(
            response,
            500,
            "prompt-assembly-failed",
            "The Design Mate prompt could not be assembled.",
            responseCorsHeaders,
          );
          return;
        }

        const upstreamController = new AbortController();
        const onRequestAbort = (): void => {
          upstreamController.abort(requestController.signal.reason);
        };
        requestController.signal.addEventListener(
          "abort",
          onRequestAbort,
          { once: true },
        );
        if (requestController.signal.aborted) {
          onRequestAbort();
        }
        const upstreamTimer = setTimeout(() => {
          upstreamController.abort(UPSTREAM_TIMEOUT_REASON);
        }, config.upstreamTimeoutMs);
        upstreamTimer.unref();
        providerId = transport.id;

        let stream: AsyncIterable<{
          readonly type: "text-delta";
          readonly delta: string;
        }>;
        try {
          stream = transport.stream(prompt, upstreamController.signal);
          if (
            typeof stream !== "object" ||
            stream === null ||
            typeof stream[Symbol.asyncIterator] !== "function"
          ) {
            throw new TypeError("invalid stream");
          }
        } catch (cause) {
          clearTimeout(upstreamTimer);
          requestController.signal.removeEventListener(
            "abort",
            onRequestAbort,
          );
          const wrapped = new TransportStartError(cause);
          const error = sanitizeTransportFailure(
            transport.id,
            wrapped.cause,
            upstreamController.signal,
          );
          errorCode = error.code;
          logStatus = 502;
          sendError(
            response,
            502,
            "provider-unavailable",
            "The Design Mate model provider could not start the request.",
            responseCorsHeaders,
          );
          return;
        }

        response.writeHead(200, {
          ...responseCorsHeaders,
          "cache-control": "no-cache, no-store",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
          "x-content-type-options": "nosniff",
        });
        response.flushHeaders();
        logStatus = 200;

        let deltaCount = 0;
        let textLength = 0;
        try {
          for await (const candidate of streamWithAbort(
            stream,
            upstreamController.signal,
          )) {
            if (upstreamController.signal.aborted) {
              throw new Error("aborted");
            }
            deltaCount += 1;
            if (deltaCount > DESIGN_MATE_CHAT_LIMITS.deltas) {
              throw new InvalidTransportOutput();
            }
            const chunk =
              snapshotValidDesignMateChatProviderChunk(candidate);
            if (!chunk) {
              throw new InvalidTransportOutput();
            }
            textLength += chunk.delta.length;
            if (
              textLength > DESIGN_MATE_CHAT_LIMITS.assistantTextLength
            ) {
              throw new InvalidTransportOutput();
            }
            await writeSseFrame(
              response,
              encodeDesignMateChatSseEvent(chunk),
              upstreamController.signal,
            );
          }
          if (upstreamController.signal.aborted) {
            throw new Error("aborted");
          }
          if (deltaCount === 0) {
            throw new InvalidTransportOutput();
          }
          await writeSseFrame(
            response,
            encodeDesignMateChatSseEvent({ type: "completed" }),
            upstreamController.signal,
          );
          response.end();
        } catch (cause) {
          const error = sanitizeTransportFailure(
            transport.id,
            cause,
            upstreamController.signal,
          );
          errorCode = error.code;
          if (
            upstreamController.signal.reason ===
              CLIENT_DISCONNECT_REASON ||
            response.destroyed
          ) {
            logStatus = 499;
          } else {
            writeTerminalFailure(response, error);
          }
        } finally {
          clearTimeout(upstreamTimer);
          requestController.signal.removeEventListener(
            "abort",
            onRequestAbort,
          );
        }
      };

      void handle()
        .catch(() => {
          if (!response.headersSent) {
            logStatus = 500;
            sendError(
              response,
              500,
              "internal-error",
              "The Design Mate service could not complete the request.",
            );
          } else if (!response.writableEnded && !response.destroyed) {
            const error = makeDesignMateProviderError(
              transport.id,
              staticErrorMessage("provider-failed"),
              { code: "provider-failed", retryable: true },
            );
            providerId = transport.id;
            errorCode = error.code;
            writeTerminalFailure(response, error);
          }
        })
        .finally(() => {
          releaseConcurrencyLease?.();
          releaseConcurrencyLease = undefined;
          clearTimeout(requestTimer);
          request.removeListener("aborted", onClientAborted);
          response.removeListener("close", onResponseClose);
          logRequest(options.logger, {
            requestId,
            route: loggedRoute,
            status: logStatus,
            durationMs: Math.max(
              0,
              Math.round(now(clock) - startedAt),
            ),
            ...(providerId === undefined ? {} : { providerId }),
            ...(errorCode === undefined ? {} : { errorCode }),
          });
        });
    },
  );
  server.maxHeadersCount = 64;
  server.requestTimeout = config.requestTimeoutMs;
  server.keepAliveTimeout = 5_000;
  return server;
}
