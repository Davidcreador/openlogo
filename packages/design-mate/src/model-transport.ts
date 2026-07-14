import {
  DESIGN_MATE_CHAT_LIMITS,
  type DesignMateChatPrompt,
  type DesignMateChatProviderChunk,
  type DesignMateProviderError,
} from "./contracts";
import { snapshotValidDesignMateChatProviderChunk } from "./chat-validation";
import { makeDesignMateProviderError } from "./provider";

export interface DesignMateModelTransport {
  readonly id: string;
  stream(
    prompt: DesignMateChatPrompt,
    signal?: AbortSignal,
  ): AsyncIterable<DesignMateChatProviderChunk>;
}

export type FakeDesignMateModelTransportOptions = {
  readonly id?: string;
  readonly chunks?: readonly DesignMateChatProviderChunk[];
  readonly error?: unknown;
  readonly respond?: (
    prompt: DesignMateChatPrompt,
    callIndex: number,
    signal?: AbortSignal,
  ) => AsyncIterable<DesignMateChatProviderChunk>;
};

export type FakeDesignMateModelTransport = DesignMateModelTransport & {
  readonly prompts: readonly DesignMateChatPrompt[];
};

export function isValidTransportId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= DESIGN_MATE_CHAT_LIMITS.providerIdLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function cancelledTransportError(
  providerId: string,
): DesignMateProviderError {
  return makeDesignMateProviderError(
    providerId,
    "The Design Mate model request was cancelled.",
    { code: "cancelled", retryable: false },
  );
}

export function throwIfTransportAborted(
  providerId: string,
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) {
    throw cancelledTransportError(providerId);
  }
}

export function createFakeDesignMateModelTransport(
  options: FakeDesignMateModelTransportOptions = {},
): FakeDesignMateModelTransport {
  const id = options.id ?? "fake-design-mate-model";
  if (!isValidTransportId(id)) {
    throw new TypeError("The fake model transport id is invalid.");
  }

  const prompts: DesignMateChatPrompt[] = [];
  return {
    id,
    prompts,
    stream: (prompt, signal) => {
      prompts.push(prompt);
      if (options.respond) {
        return options.respond(prompt, prompts.length - 1, signal);
      }
      return (async function* () {
        throwIfTransportAborted(id, signal);
        for (const candidate of options.chunks ?? []) {
          throwIfTransportAborted(id, signal);
          const chunk = snapshotValidDesignMateChatProviderChunk(candidate);
          if (!chunk) {
            throw makeDesignMateProviderError(
              id,
              "The fake model transport produced an invalid chunk.",
              { code: "invalid-chat-response", retryable: false },
            );
          }
          yield chunk;
        }
        if (options.error !== undefined) {
          throw options.error;
        }
        throwIfTransportAborted(id, signal);
      })();
    },
  };
}
