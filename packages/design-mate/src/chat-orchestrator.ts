import type { LogoDocument } from "@openlogo/core";
import {
  DESIGN_MATE_CHAT_LIMITS,
  type CollectedDesignMateChat,
  type DesignMateChatEvent,
  type DesignMateChatInput,
  type DesignMateChatProvider,
  type DesignMateChatProviderChunk,
  type DesignMateChatResult,
  type DesignMateChatRejectedProposal,
  type DesignMateChatTurnRequest,
  type DesignMateSelection,
  type PreparedDesignMateProposal,
} from "./contracts";
import {
  prepareDesignMateChatRequest,
  type PrepareDesignMateChatOptions,
} from "./chat-request";
import {
  heuristicDesignMateChatProvider,
  makeDesignMateChatCancelledError,
  normalizeDesignMateChatProviderError,
} from "./chat-provider";
import { makeDesignMateProviderError } from "./provider";
import { prepareDesignMateProposal } from "./proposals";
import { deepFreeze } from "./snapshot";
import { snapshotValidDesignMateChatProviderChunk } from "./chat-validation";

export type OrchestrateDesignMateChatOptions = {
  readonly signal?: AbortSignal;
};

export type StreamDesignMateChatOptions = PrepareDesignMateChatOptions & {
  readonly provider?: DesignMateChatProvider;
  readonly signal?: AbortSignal;
};

type NextProviderChunk =
  | {
      readonly type: "next";
      readonly result: IteratorResult<DesignMateChatProviderChunk, unknown>;
    }
  | {
      readonly type: "aborted";
    };

function boundedProviderId(provider: DesignMateChatProvider): string {
  try {
    if (
      typeof provider.id === "string" &&
      provider.id.trim().length > 0
    ) {
      return provider.id.slice(0, DESIGN_MATE_CHAT_LIMITS.providerIdLength);
    }
  } catch {
    // Use the stable fallback below.
  }
  return "unknown-chat-provider";
}

function nextProviderChunk(
  iterator: AsyncIterator<DesignMateChatProviderChunk>,
  signal: AbortSignal | undefined,
): Promise<NextProviderChunk> {
  if (!signal) {
    return Promise.resolve()
      .then(() => iterator.next())
      .then((result) => ({ type: "next" as const, result }));
  }
  if (signal.aborted) {
    return Promise.resolve({ type: "aborted" });
  }
  return new Promise<NextProviderChunk>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (!settled) {
        settled = true;
        resolve({ type: "aborted" });
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    Promise.resolve()
      .then(() => iterator.next())
      .then(
        (result) => {
          if (!settled) {
            settled = true;
            signal.removeEventListener("abort", onAbort);
            resolve({ type: "next", result });
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

function closeProviderIterator(
  iterator: AsyncIterator<DesignMateChatProviderChunk> | undefined,
): void {
  if (!iterator?.return) {
    return;
  }
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // Provider cleanup must not replace the terminal chat event.
  }
}

function baseResult(request: DesignMateChatTurnRequest): {
  readonly conversationId: string;
  readonly turnId: string;
  readonly scope: DesignMateChatTurnRequest["scope"];
  readonly context: DesignMateChatTurnRequest["context"];
  readonly identity: DesignMateChatTurnRequest["identity"];
} {
  return {
    conversationId: request.conversationId,
    turnId: request.turnId,
    scope: request.scope,
    context: request.context,
    identity: request.identity,
  };
}

/**
 * Success order is:
 * started → context → message-start →
 * (text-delta | proposal-prepared | proposal-rejected)+ →
 * message-end → completed.
 * Failure and cancellation emit exactly one terminal `failed`/`cancelled`
 * event, and never emit message-end or completed.
 */
export async function* orchestrateDesignMateChat(
  request: DesignMateChatTurnRequest,
  provider: DesignMateChatProvider = heuristicDesignMateChatProvider,
  options: OrchestrateDesignMateChatOptions = {},
): AsyncGenerator<DesignMateChatEvent, DesignMateChatResult, void> {
  const providerId = boundedProviderId(provider);
  yield deepFreeze({
    type: "started",
    providerId,
    conversationId: request.conversationId,
    turnId: request.turnId,
    scope: request.scope,
    identity: request.identity,
  });
  yield deepFreeze({ type: "context", context: request.context });

  if (options.signal?.aborted) {
    const error = makeDesignMateChatCancelledError(providerId);
    yield deepFreeze({ type: "cancelled", error });
    return deepFreeze({
      ...baseResult(request),
      status: "cancelled",
      error,
    });
  }

  const createdAt = new Date().toISOString();
  yield deepFreeze({
    type: "message-start",
    messageId: request.assistantMessageId,
    role: "assistant",
    createdAt,
  });

  let iterator: AsyncIterator<DesignMateChatProviderChunk> | undefined;
  let iteratorDone = false;
  const deltas: string[] = [];
  const preparedProposals: PreparedDesignMateProposal[] = [];
  const rejectedProposals: DesignMateChatRejectedProposal[] = [];
  const seenProposalIds = new Set<string>();
  let textLength = 0;
  let proposalCount = 0;

  try {
    const iterable = provider.stream(request, options.signal);
    if (
      typeof iterable !== "object" ||
      iterable === null ||
      typeof iterable[Symbol.asyncIterator] !== "function"
    ) {
      throw makeDesignMateProviderError(
        providerId,
        "The Design Mate chat provider did not return an async stream.",
        { code: "invalid-chat-response", retryable: false },
      );
    }
    iterator = iterable[Symbol.asyncIterator]();

    while (true) {
      const next = await nextProviderChunk(iterator, options.signal);
      if (next.type === "aborted") {
        throw makeDesignMateChatCancelledError(providerId);
      }
      if (options.signal?.aborted) {
        throw makeDesignMateChatCancelledError(providerId);
      }
      if (next.result.done) {
        iteratorDone = true;
        break;
      }
      const chunk = snapshotValidDesignMateChatProviderChunk(
        next.result.value,
      );
      if (!chunk) {
        throw makeDesignMateProviderError(
          providerId,
          "The Design Mate chat provider returned an invalid output chunk.",
          { code: "invalid-chat-response", retryable: false },
        );
      }
      if (chunk.type === "text-delta") {
        if (deltas.length >= DESIGN_MATE_CHAT_LIMITS.deltas) {
          throw makeDesignMateProviderError(
            providerId,
            "The Design Mate chat provider returned too many text deltas.",
            { code: "invalid-chat-response", retryable: false },
          );
        }
        if (
          textLength + chunk.delta.length >
          DESIGN_MATE_CHAT_LIMITS.assistantTextLength
        ) {
          throw makeDesignMateProviderError(
            providerId,
            "The Design Mate chat response exceeded the text limit.",
            { code: "invalid-chat-response", retryable: false },
          );
        }
        const index = deltas.length;
        deltas.push(chunk.delta);
        textLength += chunk.delta.length;
        yield deepFreeze({
          type: "text-delta",
          messageId: request.assistantMessageId,
          index,
          delta: chunk.delta,
        });
        continue;
      }

      if (
        proposalCount >= DESIGN_MATE_CHAT_LIMITS.proposalCandidates ||
        seenProposalIds.has(chunk.proposal.id)
      ) {
        throw makeDesignMateProviderError(
          providerId,
          "The Design Mate chat provider returned invalid proposal candidates.",
          { code: "invalid-chat-response", retryable: false },
        );
      }
      const index = proposalCount;
      proposalCount += 1;
      seenProposalIds.add(chunk.proposal.id);
      const preparation = prepareDesignMateProposal(
        request.document,
        chunk.proposal,
        {
          generation: request.identity.generation,
          revision: request.identity.revision,
        },
      );
      if (preparation.ok) {
        preparedProposals.push(preparation.prepared);
        yield deepFreeze({
          type: "proposal-prepared",
          messageId: request.assistantMessageId,
          index,
          prepared: preparation.prepared,
        });
      } else {
        const rejected = deepFreeze({
          index,
          proposalId: chunk.proposal.id,
          error: preparation.error,
        });
        rejectedProposals.push(rejected);
        yield deepFreeze({
          type: "proposal-rejected",
          messageId: request.assistantMessageId,
          ...rejected,
        });
      }
    }

    if (deltas.length === 0 && proposalCount === 0) {
      throw makeDesignMateProviderError(
        providerId,
        "The Design Mate chat provider returned no usable output.",
        { code: "invalid-chat-response", retryable: false },
      );
    }
    if (options.signal?.aborted) {
      throw makeDesignMateChatCancelledError(providerId);
    }

    const messageText =
      deltas.length > 0
        ? deltas.join("")
        : preparedProposals.length > 0
          ? `I prepared ${preparedProposals.length === 1 ? "a suggested change" : `${preparedProposals.length} suggested changes`} for your review. Nothing has been applied.`
          : "I could not prepare the suggested change safely. Nothing has been applied.";
    const message = deepFreeze({
      id: request.assistantMessageId,
      role: "assistant" as const,
      text: messageText,
      createdAt,
    });
    yield deepFreeze({ type: "message-end", message });
    yield deepFreeze({ type: "completed", message });
    return deepFreeze({
      ...baseResult(request),
      status: "completed",
      message,
      preparedProposals: [...preparedProposals],
      rejectedProposals: [...rejectedProposals],
    });
  } catch (cause) {
    const error = normalizeDesignMateChatProviderError(
      providerId,
      cause,
      options.signal,
    );
    if (error.code === "cancelled") {
      yield deepFreeze({ type: "cancelled", error });
      return deepFreeze({
        ...baseResult(request),
        status: "cancelled",
        error,
      });
    }
    yield deepFreeze({ type: "failed", error });
    return deepFreeze({
      ...baseResult(request),
      status: "failed",
      error,
    });
  } finally {
    if (!iteratorDone) {
      closeProviderIterator(iterator);
    }
  }
}

export async function* streamDesignMateChat(
  document: LogoDocument,
  selection: DesignMateSelection,
  input: DesignMateChatInput,
  options: StreamDesignMateChatOptions,
): AsyncGenerator<DesignMateChatEvent, DesignMateChatResult, void> {
  const request = prepareDesignMateChatRequest(
    document,
    selection,
    input,
    options,
  );
  return yield* orchestrateDesignMateChat(
    request,
    options.provider ?? heuristicDesignMateChatProvider,
    options.signal ? { signal: options.signal } : {},
  );
}

export const runDesignMateChat = streamDesignMateChat;

export async function collectDesignMateChat(
  document: LogoDocument,
  selection: DesignMateSelection,
  input: DesignMateChatInput,
  options: StreamDesignMateChatOptions,
): Promise<CollectedDesignMateChat> {
  const events: DesignMateChatEvent[] = [];
  const stream = streamDesignMateChat(document, selection, input, options);
  while (true) {
    const next = await stream.next();
    if (next.done) {
      return deepFreeze({
        ...next.value,
        events: [...events],
      });
    }
    events.push(next.value);
  }
}
