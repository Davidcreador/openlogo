import {
  DESIGN_MATE_CHAT_LIMITS,
  type DesignMateChatTransportEvent,
} from "./contracts";
import { isDesignMateProviderError } from "./provider";
import { deepFreeze } from "./snapshot";
import { isValidDesignMateChatProviderChunk } from "./chat-validation";

type UnknownRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: UnknownRecord,
  required: readonly string[],
): boolean {
  const allowed = new Set(required);
  const keys = Reflect.ownKeys(value);
  return (
    required.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    ) &&
    keys.every((key) => typeof key === "string" && allowed.has(key))
  );
}

function isTransportEvent(
  value: unknown,
): value is DesignMateChatTransportEvent {
  if (isValidDesignMateChatProviderChunk(value)) {
    return true;
  }
  if (!isPlainRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type === "completed") {
    return hasExactKeys(value, ["type"]);
  }
  return (
    value.type === "failed" &&
    hasExactKeys(value, ["type", "error"]) &&
    isDesignMateProviderError(value.error)
  );
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}

export function encodeDesignMateChatSseEvent(
  event: DesignMateChatTransportEvent,
): string {
  if (!isTransportEvent(event)) {
    throw new TypeError("Cannot encode an invalid Design Mate chat SSE event.");
  }
  const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  if (utf8ByteLength(frame) > DESIGN_MATE_CHAT_LIMITS.sseFrameBytes) {
    throw new RangeError("The Design Mate chat SSE frame is too large.");
  }
  return frame;
}

export const encodeDesignMateChatSse = encodeDesignMateChatSseEvent;
export const encodeDesignMateChatSSEEvent = encodeDesignMateChatSseEvent;

function parseFrame(frame: string): DesignMateChatTransportEvent | null {
  if (utf8ByteLength(frame) > DESIGN_MATE_CHAT_LIMITS.sseFrameBytes) {
    throw new RangeError("The Design Mate chat SSE frame is too large.");
  }
  if (frame.length === 0) {
    return null;
  }

  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split(/\r\n|\r|\n/)) {
    if (line.startsWith(":")) {
      continue;
    }
    if (line.length === 0) {
      throw new TypeError("The Design Mate chat SSE frame is malformed.");
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new TypeError("The Design Mate chat SSE frame is malformed.");
    }
    const field = line.slice(0, colon);
    let fieldValue = line.slice(colon + 1);
    if (fieldValue.startsWith(" ")) {
      fieldValue = fieldValue.slice(1);
    }
    if (field === "event") {
      if (eventName !== undefined || fieldValue.length === 0) {
        throw new TypeError("The Design Mate chat SSE frame is malformed.");
      }
      eventName = fieldValue;
    } else if (field === "data") {
      dataLines.push(fieldValue);
    } else {
      throw new TypeError("The Design Mate chat SSE frame is malformed.");
    }
  }

  if (dataLines.length === 0) {
    if (eventName !== undefined) {
      throw new TypeError("The Design Mate chat SSE frame is malformed.");
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join("\n"));
  } catch {
    throw new TypeError("The Design Mate chat SSE data is not valid JSON.");
  }
  if (!isTransportEvent(parsed)) {
    throw new TypeError("The Design Mate chat SSE event is invalid.");
  }
  if (eventName !== undefined && eventName !== parsed.type) {
    throw new TypeError("The Design Mate chat SSE event type does not match.");
  }
  return deepFreeze(parsed);
}

function firstFrameBoundary(
  value: string,
  startIndex: number,
  final = false,
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
      return {
        index,
        length: firstLength + secondLength,
      };
    }
    index += firstLength - 1;
  }
  return null;
}

export type DesignMateChatSseDecoder = {
  readonly push: (
    chunk: string | Uint8Array,
  ) => readonly DesignMateChatTransportEvent[];
  readonly finish: () => readonly DesignMateChatTransportEvent[];
};
export type DesignMateChatSSEDecoder = DesignMateChatSseDecoder;

export function createDesignMateChatSseDecoder(): DesignMateChatSseDecoder {
  const textDecoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let pendingBytes = 0;
  let scanOffset = 0;
  let streamBytes = 0;
  let frameCount = 0;
  let finished = false;

  const countFrame = (): void => {
    frameCount += 1;
    if (frameCount > DESIGN_MATE_CHAT_LIMITS.sseFrames) {
      throw new RangeError(
        "The Design Mate chat SSE stream has too many frames.",
      );
    }
  };

  const consumeFrames = (
    final = false,
  ): DesignMateChatTransportEvent[] => {
    const events: DesignMateChatTransportEvent[] = [];
    while (true) {
      const boundary = firstFrameBoundary(pending, scanOffset, final);
      if (!boundary) {
        scanOffset = Math.max(0, pending.length - 3);
        break;
      }
      const frame = pending.slice(0, boundary.index);
      const consumedLength = boundary.index + boundary.length;
      pendingBytes -= utf8ByteLength(pending.slice(0, consumedLength));
      pending = pending.slice(consumedLength);
      scanOffset = 0;
      countFrame();
      const event = parseFrame(frame);
      if (event) {
        events.push(event);
      }
    }
    if (pendingBytes > DESIGN_MATE_CHAT_LIMITS.sseFrameBytes) {
      throw new RangeError("The Design Mate chat SSE frame is too large.");
    }
    return events;
  };

  return {
    push: (chunk) => {
      if (finished) {
        throw new TypeError("The Design Mate chat SSE decoder is finished.");
      }
      if (typeof chunk === "string") {
        const chunkBytes = utf8ByteLength(chunk);
        if (
          streamBytes + chunkBytes >
          DESIGN_MATE_CHAT_LIMITS.sseStreamBytes
        ) {
          throw new RangeError(
            "The Design Mate chat SSE stream is too large.",
          );
        }
        streamBytes += chunkBytes;
        pendingBytes += chunkBytes;
        pending += textDecoder.decode();
        pending += chunk;
      } else if (chunk instanceof Uint8Array) {
        if (
          streamBytes + chunk.byteLength >
          DESIGN_MATE_CHAT_LIMITS.sseStreamBytes
        ) {
          throw new RangeError(
            "The Design Mate chat SSE stream is too large.",
          );
        }
        streamBytes += chunk.byteLength;
        pendingBytes += chunk.byteLength;
        pending += textDecoder.decode(chunk, { stream: true });
      } else {
        throw new TypeError("The Design Mate chat SSE chunk is invalid.");
      }
      return consumeFrames();
    },
    finish: () => {
      if (finished) {
        throw new TypeError("The Design Mate chat SSE decoder is finished.");
      }
      finished = true;
      pending += textDecoder.decode();
      const events = consumeFrames(true);
      if (pending.length > 0) {
        countFrame();
        const finalFrame = pending.replace(/(?:\r\n|\r|\n)$/, "");
        pending = "";
        pendingBytes = 0;
        scanOffset = 0;
        const event = parseFrame(finalFrame);
        if (event) {
          events.push(event);
        }
      }
      return events;
    },
  };
}

export async function* decodeDesignMateChatSse(
  chunks:
    | AsyncIterable<string | Uint8Array>
    | Iterable<string | Uint8Array>,
): AsyncGenerator<DesignMateChatTransportEvent, void, void> {
  const decoder = createDesignMateChatSseDecoder();
  for await (const chunk of chunks) {
    for (const event of decoder.push(chunk)) {
      yield event;
    }
  }
  for (const event of decoder.finish()) {
    yield event;
  }
}

export const decodeDesignMateChatSseEvents = decodeDesignMateChatSse;
export const decodeDesignMateChatSSE = decodeDesignMateChatSse;
export const createDesignMateChatSSEDecoder =
  createDesignMateChatSseDecoder;
