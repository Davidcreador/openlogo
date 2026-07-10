import {
  applyCommand,
  buildAddVariantCommand,
  collectLeafNodeIds,
  findContainerId,
} from "@openlogo/core";
import type {
  Command,
  LogoDocument,
  LogoNode,
} from "@openlogo/core";
import type {
  DesignMateAction,
  DesignMateProposalErrorCode,
  PrepareDesignMateProposalResult,
  PreparedDesignMateProposal,
} from "./contracts";
import {
  buildDocumentIdentity,
  type BuildDocumentIdentityOptions,
  type DocumentIdentity,
} from "./identity";
import {
  DESIGN_MATE_PROPOSAL_LIMITS,
  isValidDesignMateSolidColor,
  normalizeDesignMateSolidColor,
  snapshotValidDesignMateProposal,
} from "./proposal-validation";
import { deepFreeze } from "./snapshot";

export type PrepareDesignMateProposalOptions = BuildDocumentIdentityOptions;

type ReachableNode = {
  readonly node: LogoNode;
  readonly locked: boolean;
  readonly visible: boolean;
};

function reachableNode(
  document: LogoDocument,
  nodeId: string,
): ReachableNode | null {
  const node = document.nodes[nodeId];
  if (!node) {
    return null;
  }

  let locked = node.locked;
  let visible = node.visible;
  let currentId = nodeId;
  const seen = new Set<string>();
  while (!seen.has(currentId)) {
    seen.add(currentId);
    const containerId = findContainerId(document, currentId);
    if (!containerId) {
      return null;
    }
    if (document.artboards.some((artboard) => artboard.id === containerId)) {
      return { node, locked, visible };
    }
    const container = document.nodes[containerId];
    if (container?.type !== "group") {
      return null;
    }
    locked ||= container.locked;
    visible &&= container.visible;
    currentId = container.id;
  }

  return null;
}

function failure(
  code: DesignMateProposalErrorCode,
  message: string,
  actionIndex?: number,
): PrepareDesignMateProposalResult {
  const boundedMessage = message.slice(
    0,
    DESIGN_MATE_PROPOSAL_LIMITS.errorMessageLength,
  );
  return deepFreeze({
    ok: false as const,
    error: {
      _tag: "DesignMateProposalError" as const,
      code,
      message: boundedMessage,
      ...(actionIndex !== undefined ? { actionIndex } : {}),
    },
  });
}

function nodeLabel(node: LogoNode): string {
  const compact = node.name.trim().replace(/\s+/g, " ").slice(0, 120);
  return compact.length > 0 ? compact : "unnamed node";
}

function impactSummary(action: DesignMateAction, node?: LogoNode): string {
  let summary: string;
  switch (action.type) {
    case "set-text-content":
      summary = `Updated text content on ${node ? nodeLabel(node) : "a text node"}.`;
      break;
    case "set-fill-color":
      summary = `Changed the solid fill on ${node ? nodeLabel(node) : "a node"} to ${normalizeDesignMateSolidColor(action.color)}.`;
      break;
    case "set-letter-spacing":
      summary = `Set letter spacing on ${node ? nodeLabel(node) : "a text node"} to ${action.letterSpacing}.`;
      break;
    case "create-logo-variant":
      summary = `Created a non-destructive ${action.purpose} logo variant.`;
      break;
  }
  return summary.slice(0, DESIGN_MATE_PROPOSAL_LIMITS.impactSummaryLength);
}

function identitiesEqual(
  left: DocumentIdentity,
  right: DocumentIdentity,
): boolean {
  return (
    left.documentId === right.documentId &&
    left.schemaVersion === right.schemaVersion &&
    left.generation === right.generation &&
    left.revision === right.revision &&
    left.contentFingerprint === right.contentFingerprint
  );
}

/**
 * Validate and compile an untrusted proposal against a detached working copy.
 * No command is exposed unless every action succeeds in sequence.
 */
export function prepareDesignMateProposal(
  document: LogoDocument,
  unknownProposal: unknown,
  options: PrepareDesignMateProposalOptions,
): PrepareDesignMateProposalResult {
  const proposal = snapshotValidDesignMateProposal(unknownProposal);
  if (!proposal) {
    return failure(
      "invalid-proposal",
      "The Design Mate proposal does not match the accepted action contract.",
    );
  }

  try {
    const identity = buildDocumentIdentity(document, options);
    let workingDocument = structuredClone(document);
    const originalActiveArtboardId = workingDocument.activeArtboardId;
    const commands: Command[] = [];
    const changedNodeIds = new Set<string>();
    const createdArtboardIds: string[] = [];
    const summaries: string[] = [];

    for (
      let actionIndex = 0;
      actionIndex < proposal.actions.length;
      actionIndex += 1
    ) {
      const action = proposal.actions[actionIndex]!;

      if (action.type === "create-logo-variant") {
        if (
          workingDocument.artboards.length >=
          DESIGN_MATE_PROPOSAL_LIMITS.artboards
        ) {
          return failure(
            "precondition-failed",
            "A logo variant cannot be created after the document reaches 64 artboards.",
            actionIndex,
          );
        }
        if (
          workingDocument.artboards.some(
            (artboard) => artboard.purpose === action.purpose,
          )
        ) {
          return failure(
            "precondition-failed",
            "A logo variant with the requested purpose already exists.",
            actionIndex,
          );
        }
        const source = workingDocument.artboards.find(
          (artboard) => artboard.id === action.sourceArtboardId,
        );
        if (!source) {
          return failure(
            "precondition-failed",
            "The source artboard does not exist.",
            actionIndex,
          );
        }
        if (
          source.nodeIds.length === 0 ||
          collectLeafNodeIds(workingDocument, source.nodeIds).length === 0
        ) {
          return failure(
            "precondition-failed",
            "The source artboard has no artwork to clone.",
            actionIndex,
          );
        }

        const command = buildAddVariantCommand(
          workingDocument,
          source.id,
          action.purpose,
          { activate: false },
        );
        const result = applyCommand(workingDocument, command);
        if (
          result.document === workingDocument ||
          !result.document.artboards.some(
            (artboard) => artboard.id === command.artboard.id,
          )
        ) {
          return failure(
            "preparation-failed",
            "The generated variant command was rejected.",
            actionIndex,
          );
        }

        workingDocument = result.document;
        commands.push(command);
        createdArtboardIds.push(command.artboard.id);
        summaries.push(impactSummary(action));
        continue;
      }

      const reachable = reachableNode(workingDocument, action.nodeId);
      if (!reachable) {
        return failure(
          "precondition-failed",
          "The target node does not exist in a reachable artboard.",
          actionIndex,
        );
      }
      if (reachable.locked) {
        return failure(
          "precondition-failed",
          "The target node is locked.",
          actionIndex,
        );
      }
      if (!reachable.visible) {
        return failure(
          "precondition-failed",
          "The target node is hidden.",
          actionIndex,
        );
      }

      const node = reachable.node;
      let command: Command;
      switch (action.type) {
        case "set-text-content":
          if (node.type !== "text") {
            return failure(
              "precondition-failed",
              "Text content can only be changed on a text node.",
              actionIndex,
            );
          }
          if (node.content === action.content) {
            return failure(
              "no-op",
              "The requested text content is already set.",
              actionIndex,
            );
          }
          command = {
            type: "update-nodes",
            updates: [{ nodeId: node.id, patch: { content: action.content } }],
          };
          break;
        case "set-fill-color": {
          if (node.type === "group") {
            return failure(
              "precondition-failed",
              "A group cannot receive a direct fill-color action.",
              actionIndex,
            );
          }
          if (node.fill.type !== "solid") {
            return failure(
              "precondition-failed",
              "Fill color can only replace an existing solid fill.",
              actionIndex,
            );
          }
          const nextColor = normalizeDesignMateSolidColor(action.color);
          const currentColor = isValidDesignMateSolidColor(node.fill.color)
            ? normalizeDesignMateSolidColor(node.fill.color)
            : node.fill.color;
          if (currentColor === nextColor) {
            return failure(
              "no-op",
              "The requested solid fill color is already set.",
              actionIndex,
            );
          }
          command = {
            type: "update-nodes",
            updates: [
              {
                nodeId: node.id,
                patch: { fill: { type: "solid", color: nextColor } },
              },
            ],
          };
          break;
        }
        case "set-letter-spacing":
          if (node.type !== "text") {
            return failure(
              "precondition-failed",
              "Letter spacing can only be changed on a text node.",
              actionIndex,
            );
          }
          if (node.letterSpacing === action.letterSpacing) {
            return failure(
              "no-op",
              "The requested letter spacing is already set.",
              actionIndex,
            );
          }
          command = {
            type: "update-nodes",
            updates: [
              {
                nodeId: node.id,
                patch: { letterSpacing: action.letterSpacing },
              },
            ],
          };
          break;
      }

      const result = applyCommand(workingDocument, command);
      if (result.document === workingDocument) {
        return failure(
          "preparation-failed",
          "The generated node command was rejected.",
          actionIndex,
        );
      }
      workingDocument = result.document;
      commands.push(command);
      changedNodeIds.add(node.id);
      summaries.push(impactSummary(action, node));
    }

    if (commands.length === 0) {
      return failure("no-op", "The proposal does not produce any changes.");
    }
    if (
      buildDocumentIdentity(workingDocument, options).contentFingerprint ===
      identity.contentFingerprint
    ) {
      return failure(
        "no-op",
        "The proposal has no net effect on the document.",
      );
    }
    if (workingDocument.activeArtboardId !== originalActiveArtboardId) {
      return failure(
        "preparation-failed",
        "Proposal previews must preserve the active artboard.",
      );
    }

    const command = {
      type: "batch" as const,
      commands,
      label: proposal.label.slice(0, DESIGN_MATE_PROPOSAL_LIMITS.labelLength),
    };
    const prepared: PreparedDesignMateProposal = {
      proposal,
      identity,
      command,
      previewDocument: workingDocument,
      impact: {
        changedNodeIds: [...changedNodeIds],
        createdArtboardIds,
        summaries,
      },
    };

    return deepFreeze({ ok: true as const, prepared });
  } catch {
    return failure(
      "preparation-failed",
      "The Design Mate proposal could not be prepared safely.",
    );
  }
}

/**
 * Fail closed unless every identity component still matches the document that
 * the proposal was compiled against.
 */
export function isDesignMateProposalStale(
  prepared: PreparedDesignMateProposal,
  currentDocument: LogoDocument,
  options: PrepareDesignMateProposalOptions,
): boolean {
  try {
    return !identitiesEqual(
      prepared.identity,
      buildDocumentIdentity(currentDocument, options),
    );
  } catch {
    return true;
  }
}
