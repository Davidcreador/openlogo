import type { LogoDocument, ReviewScope } from "@openlogo/core";
import {
  type DesignMateChatTurnInput,
  type DesignMateChatTurnRequest,
  type DesignMateChatWireRequest,
  type DesignMateSelection,
} from "./contracts";
import { buildDesignContext, resolveDesignMateScope } from "./context";
import {
  isValidDesignMateChatSelection,
  snapshotValidDesignMateChatWireRequest,
} from "./chat-validation";
import {
  buildDocumentIdentity,
  type BuildDocumentIdentityOptions,
} from "./identity";
import {
  deepFreeze,
  structuredCloneAndDeepFreeze,
} from "./snapshot";

export type PrepareDesignMateChatOptions = BuildDocumentIdentityOptions & {
  readonly scope?: ReviewScope;
};

function assertValidVersionCounter(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
}

function normalizeSelection(
  selection: DesignMateSelection,
): DesignMateSelection {
  const candidate: DesignMateSelection = {
    selectedNodeIds: [...selection.selectedNodeIds],
    ...(selection.keyObjectId !== undefined
      ? { keyObjectId: selection.keyObjectId }
      : {}),
    ...(selection.activeGroupId !== undefined
      ? { activeGroupId: selection.activeGroupId }
      : {}),
  };
  if (!isValidDesignMateChatSelection(candidate)) {
    throw new TypeError("The Design Mate chat selection is invalid.");
  }
  return candidate;
}

/**
 * Prepare one provider-neutral chat turn from committed editor state.
 * Validation happens before any provider can observe the request, and every
 * reachable value in the returned request is detached and deeply frozen.
 */
export function prepareDesignMateChatRequest(
  document: LogoDocument,
  selection: DesignMateSelection,
  input: DesignMateChatTurnInput,
  options: PrepareDesignMateChatOptions,
): DesignMateChatTurnRequest {
  assertValidVersionCounter(options.generation, "generation");
  assertValidVersionCounter(options.revision, "revision");

  const normalizedSelection = normalizeSelection(selection);
  const requestedScope = resolveDesignMateScope(
    normalizedSelection,
    options.scope,
  );
  const context = buildDesignContext(document, normalizedSelection, {
    scope: requestedScope,
  });
  const identity = buildDocumentIdentity(document, options);
  const wireCandidate: DesignMateChatWireRequest = {
    conversationId: input.conversationId,
    turnId: input.turnId,
    assistantMessageId: input.assistantMessageId,
    identity,
    context,
    selection: normalizedSelection,
    scope: context.scope,
    history: input.history,
    userMessage: input.userMessage,
    attachments: input.attachments ?? [],
  };
  const wire = snapshotValidDesignMateChatWireRequest(wireCandidate);
  if (!wire) {
    throw new TypeError("The Design Mate chat turn input is invalid.");
  }

  const documentSnapshot = structuredCloneAndDeepFreeze(document);
  return deepFreeze({
    document: documentSnapshot,
    conversationId: wire.conversationId,
    turnId: wire.turnId,
    assistantMessageId: wire.assistantMessageId,
    identity: wire.identity,
    context: wire.context,
    selection: wire.selection,
    scope: wire.scope,
    history: wire.history,
    userMessage: wire.userMessage,
    attachments: wire.attachments,
  });
}

/**
 * Produce a detached remote-safe request. The raw document is selected out
 * explicitly rather than relying on JSON serialization behavior.
 */
export function toDesignMateChatWireRequest(
  request: DesignMateChatTurnRequest,
): DesignMateChatWireRequest {
  const candidate: DesignMateChatWireRequest = {
    conversationId: request.conversationId,
    turnId: request.turnId,
    assistantMessageId: request.assistantMessageId,
    identity: request.identity,
    context: request.context,
    selection: request.selection,
    scope: request.scope,
    history: request.history,
    userMessage: request.userMessage,
    attachments: request.attachments,
  };
  const snapshot = snapshotValidDesignMateChatWireRequest(candidate);
  if (!snapshot) {
    throw new TypeError("The Design Mate chat request is invalid.");
  }
  return snapshot;
}
