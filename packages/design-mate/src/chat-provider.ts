import type { DesignReview, ReviewFinding } from "@openlogo/core";
import {
  DESIGN_MATE_CHAT_LIMITS,
  type DesignMateChatProvider,
  type DesignMateChatProviderChunk,
  type DesignMateChatTurnRequest,
  type DesignMateProviderError,
} from "./contracts";
import {
  isDesignMateProviderError,
  makeDesignMateProviderError,
} from "./provider";
import { buildHeuristicDesignMateProposals } from "./heuristic-proposals";
import { toDesignMateChatWireRequest } from "./chat-request";
import { decodeDesignMateChatSse } from "./chat-sse";

function isAbortLike(cause: unknown): boolean {
  try {
    return (
      typeof cause === "object" &&
      cause !== null &&
      Reflect.get(cause, "name") === "AbortError"
    );
  } catch {
    return false;
  }
}

function safeErrorMessage(cause: unknown, fallback: string): string {
  try {
    if (cause instanceof Error && cause.message.trim().length > 0) {
      return cause.message;
    }
  } catch {
    // Hostile provider errors fall through to the bounded static message.
  }
  return fallback;
}

export function makeDesignMateChatCancelledError(
  providerId: string,
): DesignMateProviderError {
  return makeDesignMateProviderError(
    providerId,
    "The Design Mate chat request was cancelled.",
    { code: "cancelled", retryable: false },
  );
}

export function normalizeDesignMateChatProviderError(
  providerId: string,
  cause: unknown,
  signal?: AbortSignal,
): DesignMateProviderError {
  if (signal?.aborted || isAbortLike(cause)) {
    return makeDesignMateChatCancelledError(providerId);
  }
  try {
    if (isDesignMateProviderError(cause)) {
      return makeDesignMateProviderError(cause.providerId, cause.message, {
        code: cause.code,
        retryable: cause.retryable,
      });
    }
  } catch {
    // A provider-owned proxy may change after validation.
  }
  return makeDesignMateProviderError(
    providerId,
    safeErrorMessage(
      cause,
      "The Design Mate chat provider could not complete the request.",
    ),
    { code: "provider-failed", retryable: true },
  );
}

function throwIfAborted(
  providerId: string,
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) {
    throw makeDesignMateChatCancelledError(providerId);
  }
}

const SEVERITY_PRIORITY: Readonly<Record<ReviewFinding["severity"], number>> = {
  strong: 0,
  warning: 1,
  info: 2,
};

function highestPriorityFindings(
  review: DesignReview,
): readonly ReviewFinding[] {
  return review.findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (left, right) =>
        SEVERITY_PRIORITY[left.finding.severity] -
          SEVERITY_PRIORITY[right.finding.severity] ||
        left.index - right.index,
    )
    .slice(0, 3)
    .map(({ finding }) => finding);
}

function heuristicResponse(
  request: DesignMateChatTurnRequest,
  review: DesignReview,
): string {
  const scopeLabel =
    request.scope === "selection"
      ? "the selection"
      : request.scope === "active-artboard"
        ? "the active artboard"
        : "the document";
  const findings = highestPriorityFindings(review);
  const findingText =
    findings.length === 0
      ? "Highest-priority findings: none in this scope."
      : `Highest-priority findings: ${findings
          .map(
            (finding, index) =>
              `${index + 1}. ${finding.title} — ${finding.action}`,
          )
          .join(" ")}`;
  return `I reviewed ${scopeLabel}. ${findingText} No canvas changes were made; any document change must go through the proposal approval pipeline.`;
}

function splitResponse(text: string): readonly string[] {
  const chunkLength = Math.min(
    240,
    DESIGN_MATE_CHAT_LIMITS.deltaTextLength,
  );
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += chunkLength) {
    chunks.push(text.slice(offset, offset + chunkLength));
  }
  return chunks;
}

export function createHeuristicDesignMateChatProvider(): DesignMateChatProvider {
  const id = "heuristic-chat";
  return {
    id,
    stream: async function* (request, signal) {
      throwIfAborted(id, signal);
      const review: DesignReview = request.review;

      for (const delta of splitResponse(heuristicResponse(request, review))) {
        throwIfAborted(id, signal);
        yield { type: "text-delta", delta };
      }
      for (const proposal of buildHeuristicDesignMateProposals(
        request.document,
        review.findings,
        request.scope,
      ).slice(0, 1)) {
        throwIfAborted(id, signal);
        yield { type: "proposal-candidate", proposal };
      }
      throwIfAborted(id, signal);
    },
  };
}

export const heuristicDesignMateChatProvider =
  createHeuristicDesignMateChatProvider();

export type FakeDesignMateChatProvider = DesignMateChatProvider & {
  readonly requests: readonly DesignMateChatTurnRequest[];
};

export type FakeDesignMateChatProviderOptions = {
  readonly id?: string;
  readonly chunks?: readonly DesignMateChatProviderChunk[];
  readonly error?: DesignMateProviderError;
  readonly respond?: (
    request: DesignMateChatTurnRequest,
    callIndex: number,
    signal?: AbortSignal,
  ) => AsyncIterable<DesignMateChatProviderChunk>;
};

export function createFakeDesignMateChatProvider(
  options: FakeDesignMateChatProviderOptions = {},
): FakeDesignMateChatProvider {
  const id = options.id ?? "fake-chat";
  const requests: DesignMateChatTurnRequest[] = [];
  return {
    id,
    requests,
    stream: (request, signal) => {
      requests.push(request);
      if (options.respond) {
        return options.respond(request, requests.length - 1, signal);
      }
      return (async function* () {
        throwIfAborted(id, signal);
        if (options.error && (options.chunks?.length ?? 0) === 0) {
          throw options.error;
        }
        for (const chunk of options.chunks ?? []) {
          throwIfAborted(id, signal);
          yield chunk;
        }
        if (options.error) {
          throw options.error;
        }
        throwIfAborted(id, signal);
      })();
    },
  };
}

export type RemoteDesignMateChatProviderOptions = {
  readonly endpoint: string;
  readonly fetch?: typeof fetch;
  readonly id?: string;
};

class RemoteBodyReadError {
  readonly cause: unknown;

  constructor(cause: unknown) {
    this.cause = cause;
  }
}

async function* readResponseBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  providerId: string,
): AsyncGenerator<Uint8Array, void, void> {
  const reader = body.getReader();
  try {
    while (true) {
      if (signal?.aborted) {
        throw makeDesignMateChatCancelledError(providerId);
      }
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        if (!signal) {
          next = await reader.read();
        } else {
          next = await new Promise<ReadableStreamReadResult<Uint8Array>>(
            (resolve, reject) => {
              let settled = false;
              const onAbort = (): void => {
                if (!settled) {
                  settled = true;
                  void reader.cancel().catch(() => undefined);
                  reject(makeDesignMateChatCancelledError(providerId));
                }
              };
              signal.addEventListener("abort", onAbort, { once: true });
              if (signal.aborted) {
                onAbort();
              }
              Promise.resolve()
                .then(() => reader.read())
                .then(
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
            },
          );
        }
      } catch (cause) {
        throw new RemoteBodyReadError(cause);
      }
      if (next.done) {
        return;
      }
      if (!(next.value instanceof Uint8Array)) {
        throw new TypeError("The remote chat response contained invalid bytes.");
      }
      yield next.value;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The response may already be closed or aborted.
    }
    try {
      reader.releaseLock();
    } catch {
      // A hostile stream may leave a read pending after cancellation.
    }
  }
}

function httpFailure(
  providerId: string,
  status: number,
): DesignMateProviderError {
  if (status === 429) {
    return makeDesignMateProviderError(
      providerId,
      "The Design Mate chat provider is rate limited.",
      { code: "rate-limited", retryable: true },
    );
  }
  if (status >= 400 && status < 500) {
    return makeDesignMateProviderError(
      providerId,
      "The Design Mate chat provider rejected the request.",
      { code: "invalid-request", retryable: false },
    );
  }
  return makeDesignMateProviderError(
    providerId,
    "The Design Mate chat provider is unavailable.",
    { code: "provider-failed", retryable: true },
  );
}

export function createRemoteDesignMateChatProvider(
  options: RemoteDesignMateChatProviderOptions,
): DesignMateChatProvider {
  const id = options.id ?? "remote-chat";
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (
    typeof options.endpoint !== "string" ||
    options.endpoint.trim().length === 0
  ) {
    throw new TypeError("A remote Design Mate chat endpoint is required.");
  }
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }

  return {
    id,
    stream: async function* (request, signal) {
      throwIfAborted(id, signal);
      let wire;
      try {
        wire = toDesignMateChatWireRequest(request);
      } catch {
        throw makeDesignMateProviderError(
          id,
          "The Design Mate chat request is invalid.",
          { code: "invalid-request", retryable: false },
        );
      }
      let response: Response;
      try {
        response = await fetchImplementation(options.endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            accept: "text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify(wire),
          ...(signal ? { signal } : {}),
        });
      } catch (cause) {
        throw normalizeDesignMateChatProviderError(id, cause, signal);
      }
      throwIfAborted(id, signal);
      if (!response.ok) {
        throw httpFailure(id, response.status);
      }
      const contentType = response.headers.get("content-type");
      if (
        contentType === null ||
        !contentType.toLowerCase().startsWith("text/event-stream")
      ) {
        throw makeDesignMateProviderError(
          id,
          "The Design Mate chat provider returned an invalid content type.",
          { code: "invalid-chat-response", retryable: false },
        );
      }
      if (!response.body) {
        throw makeDesignMateProviderError(
          id,
          "The Design Mate chat provider returned an empty response.",
          { code: "invalid-chat-response", retryable: false },
        );
      }

      let terminal = false;
      try {
        for await (const event of decodeDesignMateChatSse(
          readResponseBody(response.body, signal, id),
        )) {
          throwIfAborted(id, signal);
          if (terminal) {
            throw new TypeError(
              "The Design Mate chat provider emitted data after completion.",
            );
          }
          if (
            event.type === "text-delta" ||
            event.type === "proposal-candidate"
          ) {
            yield event;
          } else if (event.type === "completed") {
            terminal = true;
          } else {
            const code =
              event.error.code === "invalid-review"
                ? "invalid-chat-response"
                : event.error.code;
            throw makeDesignMateProviderError(id, event.error.message, {
              code,
              retryable: event.error.retryable,
            });
          }
        }
      } catch (cause) {
        if (cause instanceof RemoteBodyReadError) {
          throw normalizeDesignMateChatProviderError(
            id,
            cause.cause,
            signal,
          );
        }
        if (isDesignMateProviderError(cause)) {
          throw normalizeDesignMateChatProviderError(id, cause, signal);
        }
        if (signal?.aborted || isAbortLike(cause)) {
          throw makeDesignMateChatCancelledError(id);
        }
        throw makeDesignMateProviderError(
          id,
          safeErrorMessage(
            cause,
            "The Design Mate chat provider returned malformed SSE.",
          ),
          { code: "invalid-chat-response", retryable: false },
        );
      }
      if (!terminal) {
        throw makeDesignMateProviderError(
          id,
          "The Design Mate chat provider ended without a terminal event.",
          { code: "invalid-chat-response", retryable: false },
        );
      }
    },
  };
}

export function createFallbackDesignMateChatProvider(
  primary: DesignMateChatProvider,
  fallback: DesignMateChatProvider,
): DesignMateChatProvider {
  const id = `${primary.id}+${fallback.id}`.slice(
    0,
    DESIGN_MATE_CHAT_LIMITS.providerIdLength,
  );
  return {
    id,
    stream: async function* (request, signal) {
      let emittedPrimaryChunk = false;
      try {
        for await (const chunk of primary.stream(request, signal)) {
          emittedPrimaryChunk = true;
          yield chunk;
        }
        return;
      } catch (cause) {
        const error = normalizeDesignMateChatProviderError(
          primary.id,
          cause,
          signal,
        );
        const canFallback =
          !emittedPrimaryChunk &&
          !signal?.aborted &&
          error.retryable &&
          (error.code === "provider-failed" ||
            error.code === "rate-limited");
        if (!canFallback) {
          throw error;
        }
      }
      for await (const chunk of fallback.stream(request, signal)) {
        yield chunk;
      }
    },
  };
}
