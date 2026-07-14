import {
  DESIGN_MATE_CHAT_LIMITS,
  type DesignMateChatPrompt,
  type DesignMateChatProviderChunk,
  type DesignMateProviderError,
} from "./contracts";
import {
  DESIGN_MATE_CHAT_COLOR_CONTRAST_TOOL_NAME,
  DESIGN_MATE_CHAT_EXPORT_OPTIONS_TOOL_NAME,
  DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL_NAME,
  DESIGN_MATE_CHAT_MODEL_TOOLS,
  DESIGN_MATE_CHAT_PROPOSAL_TOOL,
  DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME,
  executeDesignMateChatReadOnlyTool,
  snapshotDesignMateChatProposalToolArguments,
} from "./chat-tools";
import { snapshotValidDesignMateChatProviderChunk } from "./chat-validation";
import {
  isDesignMateProviderError,
  makeDesignMateProviderError,
} from "./provider";
import { isValidDesignReview } from "./validation";
import {
  cancelledTransportError,
  isValidTransportId,
  throwIfTransportAborted,
  type DesignMateModelTransport,
} from "./model-transport";

const UTF8_ENCODER = new TextEncoder();

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).length;
}

export const OPENAI_RESPONSES_STREAM_LIMITS = Object.freeze({
  frames: 2_048,
  frameBytes: DESIGN_MATE_CHAT_LIMITS.sseFrameBytes,
  streamBytes: 4 * 1_024 * 1_024,
  deltas: DESIGN_MATE_CHAT_LIMITS.deltas,
  proposalArgumentBytes: DESIGN_MATE_CHAT_LIMITS.proposalSerializedBytes,
} as const);
export const OPENAI_RESPONSES_DEFAULT_MAX_OUTPUT_TOKENS = 1_200;
export const OPENAI_RESPONSES_LOOP_LIMITS = Object.freeze({
  modelSteps: DESIGN_MATE_CHAT_LIMITS.modelSteps,
  readOnlyToolCalls: DESIGN_MATE_CHAT_LIMITS.readOnlyToolCalls,
} as const);

export type OpenAIResponsesImageDetail = "low" | "auto";

export type OpenAIResponsesTransportOptions = {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly imageDetail?: OpenAIResponsesImageDetail;
  readonly maxOutputTokens?: number;
  readonly id?: string;
  readonly fetch?: typeof fetch;
};

type SseFrame = {
  readonly eventName?: string;
  readonly data: string;
};

class OpenAIStreamProtocolError {
  readonly _tag = "OpenAIStreamProtocolError";
}

class OpenAIStreamReadError {
  readonly _tag = "OpenAIStreamReadError";
}

function providerError(
  providerId: string,
  code: DesignMateProviderError["code"],
  message: string,
  retryable: boolean,
): DesignMateProviderError {
  return makeDesignMateProviderError(providerId, message, {
    code,
    retryable,
  });
}

function invalidResponse(providerId: string): DesignMateProviderError {
  return providerError(
    providerId,
    "invalid-chat-response",
    "The OpenAI Responses provider returned an invalid stream.",
    false,
  );
}

function unavailable(providerId: string): DesignMateProviderError {
  return providerError(
    providerId,
    "provider-failed",
    "The OpenAI Responses provider is unavailable.",
    true,
  );
}

function failedResponse(providerId: string): DesignMateProviderError {
  return providerError(
    providerId,
    "provider-failed",
    "The OpenAI Responses provider could not complete the request.",
    true,
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

export function normalizeOpenAIResponsesBaseUrl(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    value.trim() !== value
  ) {
    throw new TypeError("The provider base URL is invalid.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("The provider base URL is invalid.");
  }
  if (
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname))) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TypeError("The provider base URL is invalid.");
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = pathname.length === 0 ? "/" : pathname;
  const normalized = parsed.toString().replace(/\/$/, "");
  return normalized;
}

function validateSecret(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 8_192 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError("A valid provider API key is required.");
  }
}

function validateModel(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError("A valid provider model is required.");
  }
}

function validateMaxOutputTokens(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 16 ||
    value > 16_000
  ) {
    throw new TypeError("The provider output token limit is invalid.");
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isAbortLike(value: unknown): boolean {
  try {
    return (
      typeof value === "object" &&
      value !== null &&
      Reflect.get(value, "name") === "AbortError"
    );
  } catch {
    return false;
  }
}

function firstFrameBoundary(
  value: string,
  startIndex: number,
  final: boolean,
): { readonly index: number; readonly length: number } | null {
  const lineEndingLength = (index: number): number => {
    const character = value[index];
    if (character === "\n") {
      return 1;
    }
    if (character !== "\r") {
      return 0;
    }
    if (value[index + 1] === "\n") {
      return 2;
    }
    return index + 1 < value.length || final ? 1 : -1;
  };

  const scanStart =
    startIndex > 0 &&
    value[startIndex] === "\n" &&
    value[startIndex - 1] === "\r"
      ? startIndex - 1
      : startIndex;
  for (let index = scanStart; index < value.length; index += 1) {
    const firstLength = lineEndingLength(index);
    if (firstLength < 0) {
      return null;
    }
    if (firstLength === 0) {
      continue;
    }
    const secondLength = lineEndingLength(index + firstLength);
    if (secondLength > 0) {
      return { index, length: firstLength + secondLength };
    }
    index += firstLength - 1;
  }
  return null;
}

function parseSseFrame(value: string): SseFrame | null {
  if (utf8ByteLength(value) > OPENAI_RESPONSES_STREAM_LIMITS.frameBytes) {
    throw new OpenAIStreamProtocolError();
  }

  let eventName: string | undefined;
  const dataLines: string[] = [];
  let hasNonCommentField = false;
  for (const line of value.split(/\r\n|\r|\n/)) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let fieldValue = colon < 0 ? "" : line.slice(colon + 1);
    if (fieldValue.startsWith(" ")) {
      fieldValue = fieldValue.slice(1);
    }
    if (field === "event") {
      if (
        eventName !== undefined ||
        fieldValue.length === 0 ||
        fieldValue.length > 128
      ) {
        throw new OpenAIStreamProtocolError();
      }
      eventName = fieldValue;
      hasNonCommentField = true;
    } else if (field === "data") {
      dataLines.push(fieldValue);
      hasNonCommentField = true;
    } else if (field !== "id" && field !== "retry") {
      throw new OpenAIStreamProtocolError();
    } else {
      hasNonCommentField = true;
    }
  }

  if (!hasNonCommentField) {
    return null;
  }
  if (dataLines.length === 0) {
    throw new OpenAIStreamProtocolError();
  }
  return {
    ...(eventName === undefined ? {} : { eventName }),
    data: dataLines.join("\n"),
  };
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  providerId: string,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) {
    return reader.read();
  }
  if (signal.aborted) {
    throw cancelledTransportError(providerId);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      void reader.cancel().catch(() => undefined);
      reject(cancelledTransportError(providerId));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", onAbort);
          reject(new OpenAIStreamReadError());
        }
      },
    );
  });
}

async function* decodeResponseFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  providerId: string,
): AsyncGenerator<SseFrame, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let pendingBytes = 0;
  let scanOffset = 0;
  let frameCount = 0;
  let streamBytes = 0;

  const consume = function* (final: boolean): Generator<SseFrame, void, void> {
    while (true) {
      const boundary = firstFrameBoundary(pending, scanOffset, final);
      if (!boundary) {
        scanOffset = Math.max(0, pending.length - 3);
        break;
      }
      const rawFrame = pending.slice(0, boundary.index);
      const consumedLength = boundary.index + boundary.length;
      pendingBytes -= utf8ByteLength(pending.slice(0, consumedLength));
      pending = pending.slice(consumedLength);
      scanOffset = 0;
      frameCount += 1;
      if (frameCount > OPENAI_RESPONSES_STREAM_LIMITS.frames) {
        throw new OpenAIStreamProtocolError();
      }
      const frame = parseSseFrame(rawFrame);
      if (frame) {
        yield frame;
      }
    }
    if (pendingBytes > OPENAI_RESPONSES_STREAM_LIMITS.frameBytes) {
      throw new OpenAIStreamProtocolError();
    }
  };

  try {
    while (true) {
      throwIfTransportAborted(providerId, signal);
      const result = await readWithAbort(reader, signal, providerId);
      if (result.done) {
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw new OpenAIStreamProtocolError();
      }
      streamBytes += result.value.byteLength;
      pendingBytes += result.value.byteLength;
      if (streamBytes > OPENAI_RESPONSES_STREAM_LIMITS.streamBytes) {
        throw new OpenAIStreamProtocolError();
      }
      try {
        pending += decoder.decode(result.value, { stream: true });
      } catch {
        throw new OpenAIStreamProtocolError();
      }
      yield* consume(false);
    }
    try {
      pending += decoder.decode();
    } catch {
      throw new OpenAIStreamProtocolError();
    }
    yield* consume(true);
    if (pending.length > 0) {
      frameCount += 1;
      if (frameCount > OPENAI_RESPONSES_STREAM_LIMITS.frames) {
        throw new OpenAIStreamProtocolError();
      }
      const finalFrame = pending.replace(/(?:\r\n|\r|\n)$/, "");
      pending = "";
      pendingBytes = 0;
      scanOffset = 0;
      const frame = parseSseFrame(finalFrame);
      if (frame) {
        yield frame;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or aborted.
    }
    try {
      reader.releaseLock();
    } catch {
      // A custom fetch stream may retain a read during cancellation.
    }
  }
}

function buildOpenAIInput(
  prompt: DesignMateChatPrompt,
  imageDetail: OpenAIResponsesImageDetail,
): readonly Record<string, unknown>[] {
  if (
    typeof prompt.system !== "string" ||
    prompt.system.length === 0 ||
    !isPlainRecord(prompt.contextMessage) ||
    prompt.contextMessage.role !== "user" ||
    typeof prompt.contextMessage.text !== "string" ||
    prompt.contextMessage.text.length === 0 ||
    !Array.isArray(prompt.messages) ||
    prompt.messages.length === 0 ||
    !Array.isArray(prompt.images) ||
    !isValidDesignReview(prompt.review)
  ) {
    throw new TypeError("The Design Mate model prompt is invalid.");
  }

  const lastIndex = prompt.messages.length - 1;
  const messages = prompt.messages.map((message, index) => {
    if (
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.text !== "string"
    ) {
      throw new TypeError("The Design Mate model prompt is invalid.");
    }
    const isLast = index === lastIndex;
    if (isLast && message.role !== "user") {
      throw new TypeError("The Design Mate model prompt is invalid.");
    }
    const content: Record<string, unknown>[] = [];
    if (message.text.length > 0) {
      // The Responses API requires output_text for assistant history items;
      // input_text there is rejected with a 400.
      content.push({
        type: message.role === "assistant" ? "output_text" : "input_text",
        text: message.text,
      });
    }
    if (isLast) {
      for (const image of prompt.images) {
        if (
          image.mimeType !== "image/png" ||
          typeof image.dataUrl !== "string" ||
          !image.dataUrl.startsWith("data:image/png;base64,")
        ) {
          throw new TypeError("The Design Mate model prompt is invalid.");
        }
        content.push({
          type: "input_image",
          image_url: image.dataUrl,
          detail: imageDetail,
        });
      }
    }
    if (content.length === 0) {
      throw new TypeError("The Design Mate model prompt is invalid.");
    }
    return { role: message.role, content };
  });
  return [
    {
      role: "user",
      content: [
        {
          type: "input_text",
          text: prompt.contextMessage.text,
        },
      ],
    },
    ...messages,
  ];
}

function httpError(providerId: string, status: number): DesignMateProviderError {
  if (status === 429) {
    return providerError(
      providerId,
      "rate-limited",
      "The OpenAI Responses provider is rate limited.",
      true,
    );
  }
  if (status >= 400 && status < 500) {
    return providerError(
      providerId,
      "invalid-request",
      "The OpenAI Responses provider rejected the request.",
      false,
    );
  }
  return unavailable(providerId);
}

function parseEvent(frame: SseFrame): {
  readonly type: string;
  readonly value: Record<string, unknown>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    throw new OpenAIStreamProtocolError();
  }
  if (!isPlainRecord(parsed)) {
    throw new OpenAIStreamProtocolError();
  }
  const payloadType = parsed.type;
  const type =
    typeof payloadType === "string" ? payloadType : frame.eventName;
  if (
    typeof type !== "string" ||
    type.length === 0 ||
    type.length > 128 ||
    (frame.eventName !== undefined &&
      typeof payloadType === "string" &&
      frame.eventName !== payloadType)
  ) {
    throw new OpenAIStreamProtocolError();
  }
  return { type, value: parsed };
}

type OpenAIFunctionCallState = {
  readonly name: string;
  readonly callId: string;
  readonly outputIndex: number;
  arguments: string;
  done: boolean;
  outputDone: boolean;
};

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function isFunctionCallId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= DESIGN_MATE_CHAT_LIMITS.referenceIdLength
  );
}

function boundedFunctionArguments(value: unknown): value is string {
  return (
    typeof value === "string" &&
    utf8ByteLength(value) <=
      OPENAI_RESPONSES_STREAM_LIMITS.proposalArgumentBytes
  );
}

const READ_ONLY_TOOL_NAMES = new Set([
  DESIGN_MATE_CHAT_INSPECT_REVIEW_TOOL_NAME,
  DESIGN_MATE_CHAT_EXPORT_OPTIONS_TOOL_NAME,
  DESIGN_MATE_CHAT_COLOR_CONTRAST_TOOL_NAME,
]);

function isReadOnlyToolName(value: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(value);
}

export function createOpenAIResponsesTransport(
  options: OpenAIResponsesTransportOptions,
): DesignMateModelTransport {
  validateSecret(options.apiKey);
  validateModel(options.model);
  const baseUrl = normalizeOpenAIResponsesBaseUrl(options.baseUrl);
  const endpoint = `${baseUrl}/responses`;
  const imageDetail = options.imageDetail ?? "auto";
  if (imageDetail !== "auto" && imageDetail !== "low") {
    throw new TypeError("The provider image detail is invalid.");
  }
  const maxOutputTokens = validateMaxOutputTokens(
    options.maxOutputTokens ??
      OPENAI_RESPONSES_DEFAULT_MAX_OUTPUT_TOKENS,
  );
  const id = options.id ?? "openai-responses";
  if (!isValidTransportId(id)) {
    throw new TypeError("The provider id is invalid.");
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("A fetch implementation is required.");
  }

  return {
    id,
    stream: async function* (prompt, signal) {
      throwIfTransportAborted(id, signal);
      let input: readonly Record<string, unknown>[];
      try {
        input = buildOpenAIInput(prompt, imageDetail);
      } catch {
        throw providerError(
          id,
          "invalid-request",
          "The Design Mate model prompt is invalid.",
          false,
        );
      }

      let totalDeltaCount = 0;
      let totalProposalCount = 0;
      let readOnlyToolCount = 0;

      for (
        let step = 0;
        step < OPENAI_RESPONSES_LOOP_LIMITS.modelSteps;
        step += 1
      ) {
        throwIfTransportAborted(id, signal);
        const allowReadOnlyTools =
          readOnlyToolCount <
            OPENAI_RESPONSES_LOOP_LIMITS.readOnlyToolCalls &&
          step < OPENAI_RESPONSES_LOOP_LIMITS.modelSteps - 1;
        const tools = allowReadOnlyTools
          ? DESIGN_MATE_CHAT_MODEL_TOOLS
          : ([DESIGN_MATE_CHAT_PROPOSAL_TOOL] as const);
        const allowedToolNames = new Set(tools.map((tool) => tool.name));
        let requestBody: string;
        try {
          requestBody = JSON.stringify({
            model: options.model,
            instructions: prompt.system,
            input,
            max_output_tokens: maxOutputTokens,
            tools,
            tool_choice: "auto",
            parallel_tool_calls: false,
            stream: true,
            store: false,
          });
        } catch {
          throw providerError(
            id,
            "invalid-request",
            "The Design Mate model prompt is invalid.",
            false,
          );
        }

        let response: Response;
        try {
          response = await fetchImplementation(endpoint, {
            method: "POST",
            redirect: "error",
            headers: {
              accept: "text/event-stream",
              authorization: `Bearer ${options.apiKey}`,
              "content-type": "application/json",
            },
            body: requestBody,
            ...(signal === undefined ? {} : { signal }),
          });
        } catch (cause) {
          if (signal?.aborted || isAbortLike(cause)) {
            throw cancelledTransportError(id);
          }
          throw unavailable(id);
        }
        throwIfTransportAborted(id, signal);

        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw httpError(id, response.status);
        }
        const contentType = response.headers.get("content-type");
        if (
          contentType === null ||
          contentType.split(";", 1)[0]?.trim().toLowerCase() !==
            "text/event-stream"
        ) {
          void response.body?.cancel().catch(() => undefined);
          throw invalidResponse(id);
        }
        if (!response.body) {
          throw invalidResponse(id);
        }

        let completed = false;
        let stepDeltaCount = 0;
        let stepProposalCount = 0;
        let rejectedProposalCall = false;
        let pendingReadOnlyCall:
          | {
              readonly callId: string;
              readonly name: string;
              readonly arguments: string;
            }
          | undefined;
        const functionCalls = new Map<string, OpenAIFunctionCallState>();
        try {
          for await (const frame of decodeResponseFrames(
            response.body,
            signal,
            id,
          )) {
            throwIfTransportAborted(id, signal);
            const event = parseEvent(frame);
            if (completed) {
              throw new OpenAIStreamProtocolError();
            }
            if (event.type === "response.output_text.delta") {
              stepDeltaCount += 1;
              totalDeltaCount += 1;
              if (
                totalDeltaCount >
                OPENAI_RESPONSES_STREAM_LIMITS.deltas
              ) {
                throw new OpenAIStreamProtocolError();
              }
              const chunk = snapshotValidDesignMateChatProviderChunk({
                type: "text-delta",
                delta: event.value.delta,
              });
              if (!chunk) {
                throw new OpenAIStreamProtocolError();
              }
              yield chunk satisfies DesignMateChatProviderChunk;
            } else if (event.type === "response.output_item.added") {
              const item = event.value.item;
              if (isPlainRecord(item) && item.type === "function_call") {
                const callId = isFunctionCallId(item.call_id)
                  ? item.call_id
                  : item.id;
                if (
                  !isFunctionCallId(item.id) ||
                  !isFunctionCallId(callId) ||
                  typeof item.name !== "string" ||
                  !allowedToolNames.has(item.name) ||
                  !boundedFunctionArguments(item.arguments) ||
                  !isNonNegativeInteger(event.value.output_index) ||
                  functionCalls.has(item.id)
                ) {
                  throw new OpenAIStreamProtocolError();
                }
                functionCalls.set(item.id, {
                  name: item.name,
                  callId,
                  outputIndex: event.value.output_index,
                  arguments: item.arguments,
                  done: false,
                  outputDone: false,
                });
              }
            } else if (
              event.type === "response.function_call_arguments.delta"
            ) {
              const itemId = event.value.item_id;
              const state = isFunctionCallId(itemId)
                ? functionCalls.get(itemId)
                : undefined;
              if (
                !state ||
                state.done ||
                !isNonNegativeInteger(event.value.output_index) ||
                event.value.output_index !== state.outputIndex ||
                typeof event.value.delta !== "string" ||
                event.value.delta.length === 0
              ) {
                throw new OpenAIStreamProtocolError();
              }
              const nextArguments = `${state.arguments}${event.value.delta}`;
              if (!boundedFunctionArguments(nextArguments)) {
                throw new OpenAIStreamProtocolError();
              }
              state.arguments = nextArguments;
            } else if (
              event.type === "response.function_call_arguments.done"
            ) {
              const doneItem = isPlainRecord(event.value.item)
                ? event.value.item
                : undefined;
              const itemId = isFunctionCallId(event.value.item_id)
                ? event.value.item_id
                : doneItem && isFunctionCallId(doneItem.id)
                  ? doneItem.id
                  : undefined;
              const state = isFunctionCallId(itemId)
                ? functionCalls.get(itemId)
                : undefined;
              const doneName =
                typeof event.value.name === "string"
                  ? event.value.name
                  : doneItem && typeof doneItem.name === "string"
                    ? doneItem.name
                    : undefined;
              const doneArguments =
                typeof event.value.arguments === "string"
                  ? event.value.arguments
                  : doneItem && typeof doneItem.arguments === "string"
                    ? doneItem.arguments
                    : undefined;
              if (
                !state ||
                state.done ||
                (doneName !== undefined && doneName !== state.name) ||
                !isNonNegativeInteger(event.value.output_index) ||
                event.value.output_index !== state.outputIndex ||
                !boundedFunctionArguments(doneArguments) ||
                (state.arguments.length > 0 &&
                  state.arguments !== doneArguments)
              ) {
                throw new OpenAIStreamProtocolError();
              }
              let parsedArguments: unknown;
              try {
                parsedArguments = JSON.parse(doneArguments);
              } catch {
                throw new OpenAIStreamProtocolError();
              }
              state.arguments = doneArguments;
              state.done = true;

              if (state.name === DESIGN_MATE_CHAT_PROPOSAL_TOOL_NAME) {
                if (
                  totalProposalCount >=
                  DESIGN_MATE_CHAT_LIMITS.proposalCandidates
                ) {
                  throw new OpenAIStreamProtocolError();
                }
                const proposal =
                  snapshotDesignMateChatProposalToolArguments(
                    parsedArguments,
                    `chat-proposal-${globalThis.crypto.randomUUID()}`,
                  );
                if (!proposal) {
                  rejectedProposalCall = true;
                  continue;
                }
                const chunk = snapshotValidDesignMateChatProviderChunk({
                  type: "proposal-candidate",
                  proposal,
                });
                if (!chunk) {
                  throw new OpenAIStreamProtocolError();
                }
                stepProposalCount += 1;
                totalProposalCount += 1;
                yield chunk satisfies DesignMateChatProviderChunk;
              } else if (isReadOnlyToolName(state.name)) {
                if (pendingReadOnlyCall) {
                  throw new OpenAIStreamProtocolError();
                }
                pendingReadOnlyCall = {
                  callId: state.callId,
                  name: state.name,
                  arguments: doneArguments,
                };
              } else {
                throw new OpenAIStreamProtocolError();
              }
            } else if (event.type === "response.output_item.done") {
              const item = event.value.item;
              if (isPlainRecord(item) && item.type === "function_call") {
                const state = isFunctionCallId(item.id)
                  ? functionCalls.get(item.id)
                  : undefined;
                if (
                  !state ||
                  !state.done ||
                  state.outputDone ||
                  (typeof item.name === "string" &&
                    item.name !== state.name) ||
                  !isNonNegativeInteger(event.value.output_index) ||
                  event.value.output_index !== state.outputIndex
                ) {
                  throw new OpenAIStreamProtocolError();
                }
                state.outputDone = true;
              }
            } else if (event.type === "response.completed") {
              if (
                !isPlainRecord(event.value.response) ||
                event.value.response.status !== "completed" ||
                [...functionCalls.values()].some(
                  (state) => !state.done || !state.outputDone,
                )
              ) {
                throw new OpenAIStreamProtocolError();
              }
              completed = true;
            } else if (
              event.type === "response.failed" ||
              event.type === "response.incomplete" ||
              event.type === "response.cancelled" ||
              event.type === "error"
            ) {
              throw failedResponse(id);
            }
            // Other bounded Responses lifecycle events carry no text delta.
          }
        } catch (cause) {
          if (signal?.aborted || isAbortLike(cause)) {
            throw cancelledTransportError(id);
          }
          if (isDesignMateProviderError(cause)) {
            throw cause;
          }
          if (cause instanceof OpenAIStreamReadError) {
            throw unavailable(id);
          }
          throw invalidResponse(id);
        }
        if (!completed) {
          throw invalidResponse(id);
        }
        if (pendingReadOnlyCall) {
          if (
            stepProposalCount > 0 ||
            readOnlyToolCount >=
              OPENAI_RESPONSES_LOOP_LIMITS.readOnlyToolCalls ||
            step >= OPENAI_RESPONSES_LOOP_LIMITS.modelSteps - 1
          ) {
            throw invalidResponse(id);
          }
          let parsedArguments: unknown;
          try {
            parsedArguments = JSON.parse(pendingReadOnlyCall.arguments);
          } catch {
            throw invalidResponse(id);
          }
          const output = executeDesignMateChatReadOnlyTool(
            pendingReadOnlyCall.name,
            parsedArguments,
            prompt.review,
          );
          if (!output) {
            throw invalidResponse(id);
          }
          readOnlyToolCount += 1;
          input = [
            ...input,
            {
              type: "function_call",
              call_id: pendingReadOnlyCall.callId,
              name: pendingReadOnlyCall.name,
              arguments: pendingReadOnlyCall.arguments,
            },
            {
              type: "function_call_output",
              call_id: pendingReadOnlyCall.callId,
              output,
            },
          ];
          continue;
        }
        if (stepDeltaCount === 0 && stepProposalCount === 0) {
          if (!rejectedProposalCall) {
            throw invalidResponse(id);
          }
          const chunk = snapshotValidDesignMateChatProviderChunk({
            type: "text-delta",
            delta:
              "I could not prepare that suggestion safely. No canvas changes were made.",
          });
          if (!chunk) {
            throw invalidResponse(id);
          }
          totalDeltaCount += 1;
          yield chunk satisfies DesignMateChatProviderChunk;
        }
        return;
      }

      throw invalidResponse(id);
    },
  };
}
