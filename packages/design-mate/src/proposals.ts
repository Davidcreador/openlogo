import {
  alignUnitOffsets,
  applyCommand,
  buildAddVariantCommand,
  collectLeafNodeIds,
  distributeEvenGapOffsets,
  findContainerId,
  rotateLeafPatches,
  scaleLeafPatches,
  selectionFrame,
  selectionFrameCenter,
  translateLeafPatches,
  unitBounds,
} from "@openlogo/core";
import type {
  Command,
  LogoDocument,
  LogoNode,
  NodePatch,
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
  readonly artboardId: string;
  readonly locked: boolean;
  readonly visible: boolean;
};

type GeometryAction = Extract<
  DesignMateAction,
  {
    readonly type:
      | "translate-nodes"
      | "scale-nodes"
      | "rotate-nodes"
      | "align-nodes"
      | "distribute-nodes";
  }
>;

type GeometryTargets = {
  readonly artboardId: string;
  readonly leafIds: readonly string[];
};

type GeometryTargetResult =
  | { readonly ok: true; readonly targets: GeometryTargets }
  | { readonly ok: false; readonly message: string };

type NodeUpdate = { readonly nodeId: string; readonly patch: NodePatch };

function isGeometryAction(action: DesignMateAction): action is GeometryAction {
  return (
    action.type === "translate-nodes" ||
    action.type === "scale-nodes" ||
    action.type === "rotate-nodes" ||
    action.type === "align-nodes" ||
    action.type === "distribute-nodes"
  );
}

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
      return { node, artboardId: containerId, locked, visible };
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

function resolveGeometryTargets(
  document: LogoDocument,
  nodeIds: readonly string[],
): GeometryTargetResult {
  const artboardIds = new Set<string>();
  const leafIds: string[] = [];
  const seenLeaves = new Set<string>();

  for (const nodeId of nodeIds) {
    const root = reachableNode(document, nodeId);
    if (!root) {
      return {
        ok: false,
        message: "A geometry target does not exist in a reachable artboard.",
      };
    }
    if (root.locked) {
      return { ok: false, message: "A geometry target is locked." };
    }
    if (!root.visible) {
      return { ok: false, message: "A geometry target is hidden." };
    }
    artboardIds.add(root.artboardId);

    const rootLeafIds = collectLeafNodeIds(document, [nodeId]);
    if (rootLeafIds.length === 0) {
      return {
        ok: false,
        message: "A geometry target does not contain visible artwork.",
      };
    }
    for (const leafId of rootLeafIds) {
      if (seenLeaves.has(leafId)) {
        return {
          ok: false,
          message: "Geometry targets cannot overlap or contain each other.",
        };
      }
      const leaf = reachableNode(document, leafId);
      if (!leaf || leaf.node.type === "group") {
        return {
          ok: false,
          message: "A geometry target contains unreachable artwork.",
        };
      }
      if (leaf.locked) {
        return {
          ok: false,
          message: "A geometry target contains locked artwork.",
        };
      }
      if (!leaf.visible) {
        return {
          ok: false,
          message: "A geometry target contains hidden artwork.",
        };
      }
      if (leaf.node.type === "text" && leaf.node.onPath) {
        return {
          ok: false,
          message: "Text attached to a path cannot use box geometry actions.",
        };
      }
      if (leaf.artboardId !== root.artboardId) {
        return {
          ok: false,
          message: "A geometry target crosses artboard boundaries.",
        };
      }
      seenLeaves.add(leafId);
      leafIds.push(leafId);
    }
  }

  if (artboardIds.size !== 1) {
    return {
      ok: false,
      message: "Geometry targets must all belong to one artboard.",
    };
  }
  return {
    ok: true,
    targets: {
      artboardId: [...artboardIds][0]!,
      leafIds,
    },
  };
}

function geometryUpdatesAreSafe(updates: readonly NodeUpdate[]): boolean {
  if (updates.length === 0) {
    return false;
  }
  const maximum = DESIGN_MATE_PROPOSAL_LIMITS.maximumGeometryMagnitude;
  return updates.every(({ patch }) => {
    for (const key of ["x", "y"] as const) {
      const value = patch[key];
      if (
        value !== undefined &&
        (!Number.isFinite(value) || Math.abs(value) > maximum)
      ) {
        return false;
      }
    }
    for (const key of ["width", "height"] as const) {
      const value = patch[key];
      if (
        value !== undefined &&
        (!Number.isFinite(value) || value <= 0 || value > maximum)
      ) {
        return false;
      }
    }
    if (
      patch.rotation !== undefined &&
      !Number.isFinite(patch.rotation)
    ) {
      return false;
    }
    return !(
      patch.fontSize !== undefined &&
      (!Number.isFinite(patch.fontSize) ||
        patch.fontSize < DESIGN_MATE_PROPOSAL_LIMITS.minimumFontSize ||
        patch.fontSize > DESIGN_MATE_PROPOSAL_LIMITS.maximumFontSize)
    );
  });
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
    case "translate-nodes":
      summary = `Moved ${action.nodeIds.length} ${action.nodeIds.length === 1 ? "object" : "objects"} by ${action.dx}px horizontally and ${action.dy}px vertically.`;
      break;
    case "scale-nodes":
      summary = `Scaled ${action.nodeIds.length} ${action.nodeIds.length === 1 ? "object" : "objects"} to ${action.scaleX}× width and ${action.scaleY}× height around the selection centre.`;
      break;
    case "rotate-nodes":
      summary = `Rotated ${action.nodeIds.length} ${action.nodeIds.length === 1 ? "object" : "objects"} by ${action.degrees} degrees around the selection centre.`;
      break;
    case "align-nodes":
      summary = `Aligned ${action.nodeIds.length} ${action.nodeIds.length === 1 ? "object" : "objects"} to the ${action.edge} of the ${action.reference}.`;
      break;
    case "distribute-nodes":
      summary = `Distributed gaps between ${action.nodeIds.length} objects on the ${action.axis} axis.`;
      break;
    case "set-font-family":
      summary = `Set the font family on ${node ? nodeLabel(node) : "a text node"} to ${action.fontFamily.trim()}.`;
      break;
    case "set-font-size":
      summary = `Set the font size on ${node ? nodeLabel(node) : "a text node"} to ${action.fontSize}px.`;
      break;
    case "set-font-weight":
      summary = `Set the font weight on ${node ? nodeLabel(node) : "a text node"} to ${action.fontWeight}.`;
      break;
    case "set-opacity":
      summary = `Set opacity on ${node ? nodeLabel(node) : "a node"} to ${Math.round(action.opacity * 100)}%.`;
      break;
    case "set-stroke-color":
      summary = `Changed the solid stroke on ${node ? nodeLabel(node) : "a node"} to ${normalizeDesignMateSolidColor(action.color)}.`;
      break;
    case "set-stroke-width":
      summary = `Set the stroke width on ${node ? nodeLabel(node) : "a node"} to ${action.width}px.`;
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

      if (isGeometryAction(action)) {
        const resolved = resolveGeometryTargets(
          workingDocument,
          action.nodeIds,
        );
        if (!resolved.ok) {
          return failure(
            "precondition-failed",
            resolved.message,
            actionIndex,
          );
        }

        let updates: NodeUpdate[] = [];
        switch (action.type) {
          case "translate-nodes":
            updates = translateLeafPatches(
              workingDocument,
              action.nodeIds,
              action.dx,
              action.dy,
            );
            break;
          case "scale-nodes": {
            const frame = selectionFrame(workingDocument, action.nodeIds);
            if (frame) {
              updates = scaleLeafPatches(
                workingDocument,
                action.nodeIds,
                action.scaleX,
                action.scaleY,
                selectionFrameCenter(frame),
              );
            }
            break;
          }
          case "rotate-nodes": {
            const frame = selectionFrame(workingDocument, action.nodeIds);
            if (frame) {
              updates = rotateLeafPatches(
                workingDocument,
                action.nodeIds,
                action.degrees,
                selectionFrameCenter(frame),
              );
            }
            break;
          }
          case "align-nodes": {
            const units = action.nodeIds.flatMap((id) => {
              const bounds = unitBounds(workingDocument, id);
              return bounds ? [{ id, bounds }] : [];
            });
            if (units.length !== action.nodeIds.length) {
              return failure(
                "precondition-failed",
                "An alignment target has no usable bounds.",
                actionIndex,
              );
            }
            const artboard = workingDocument.artboards.find(
              (candidate) =>
                candidate.id === resolved.targets.artboardId,
            );
            if (!artboard) {
              return failure(
                "precondition-failed",
                "The alignment artboard is unavailable.",
                actionIndex,
              );
            }
            const reference =
              action.reference === "artboard"
                ? {
                    x: 0,
                    y: 0,
                    width: artboard.width,
                    height: artboard.height,
                  }
                : undefined;
            const anchorId =
              action.reference === "key-object"
                ? action.keyObjectId
                : undefined;
            const offsets = alignUnitOffsets(
              units,
              action.edge,
              reference,
              anchorId,
            );
            updates = offsets.flatMap((offset) =>
              translateLeafPatches(
                workingDocument,
                [offset.id],
                offset.dx,
                offset.dy,
              ),
            );
            break;
          }
          case "distribute-nodes": {
            const units = action.nodeIds.flatMap((id) => {
              const bounds = unitBounds(workingDocument, id);
              return bounds ? [{ id, bounds }] : [];
            });
            if (units.length !== action.nodeIds.length) {
              return failure(
                "precondition-failed",
                "A distribution target has no usable bounds.",
                actionIndex,
              );
            }
            const offsets = distributeEvenGapOffsets(units, action.axis);
            updates = offsets.flatMap((offset) =>
              translateLeafPatches(
                workingDocument,
                [offset.id],
                offset.dx,
                offset.dy,
              ),
            );
            break;
          }
        }

        if (updates.length === 0) {
          return failure(
            "no-op",
            "The requested geometry action does not move or resize any artwork.",
            actionIndex,
          );
        }
        if (!geometryUpdatesAreSafe(updates)) {
          return failure(
            "precondition-failed",
            "The requested geometry action would exceed safe document bounds.",
            actionIndex,
          );
        }

        const command: Command = { type: "update-nodes", updates };
        const result = applyCommand(workingDocument, command);
        if (result.document === workingDocument) {
          return failure(
            "preparation-failed",
            "The generated geometry command was rejected.",
            actionIndex,
          );
        }
        workingDocument = result.document;
        commands.push(command);
        for (const update of updates) {
          changedNodeIds.add(update.nodeId);
        }
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
        case "set-font-family": {
          if (node.type !== "text") {
            return failure(
              "precondition-failed",
              "Font family can only be changed on a text node.",
              actionIndex,
            );
          }
          const fontFamily = action.fontFamily.trim();
          if (node.fontFamily === fontFamily) {
            return failure(
              "no-op",
              "The requested font family is already set.",
              actionIndex,
            );
          }
          command = {
            type: "update-nodes",
            updates: [{ nodeId: node.id, patch: { fontFamily } }],
          };
          break;
        }
        case "set-font-size":
          if (node.type !== "text") {
            return failure(
              "precondition-failed",
              "Font size can only be changed on a text node.",
              actionIndex,
            );
          }
          if (node.fontSize === action.fontSize) {
            return failure(
              "no-op",
              "The requested font size is already set.",
              actionIndex,
            );
          }
          command = {
            type: "update-nodes",
            updates: [
              { nodeId: node.id, patch: { fontSize: action.fontSize } },
            ],
          };
          break;
        case "set-font-weight":
          if (node.type !== "text") {
            return failure(
              "precondition-failed",
              "Font weight can only be changed on a text node.",
              actionIndex,
            );
          }
          if (node.fontWeight === action.fontWeight) {
            return failure(
              "no-op",
              "The requested font weight is already set.",
              actionIndex,
            );
          }
          command = {
            type: "update-nodes",
            updates: [
              { nodeId: node.id, patch: { fontWeight: action.fontWeight } },
            ],
          };
          break;
        case "set-opacity":
          if (node.opacity === action.opacity) {
            return failure(
              "no-op",
              "The requested opacity is already set.",
              actionIndex,
            );
          }
          command = {
            type: "update-nodes",
            updates: [{ nodeId: node.id, patch: { opacity: action.opacity } }],
          };
          break;
        case "set-stroke-color": {
          if (node.type === "group" || !node.stroke) {
            return failure(
              "precondition-failed",
              "Stroke color can only replace an existing stroke on a leaf node.",
              actionIndex,
            );
          }
          if (node.stroke.paint && node.stroke.paint.type !== "solid") {
            return failure(
              "precondition-failed",
              "Stroke color cannot replace an existing gradient stroke.",
              actionIndex,
            );
          }
          const nextColor = normalizeDesignMateSolidColor(action.color);
          const visibleColor =
            node.stroke.paint?.type === "solid"
              ? node.stroke.paint.color
              : node.stroke.color;
          const currentColor = isValidDesignMateSolidColor(visibleColor)
            ? normalizeDesignMateSolidColor(visibleColor)
            : visibleColor;
          if (currentColor === nextColor) {
            return failure(
              "no-op",
              "The requested solid stroke color is already set.",
              actionIndex,
            );
          }
          command = {
            type: "update-nodes",
            updates: [
              {
                nodeId: node.id,
                patch: {
                  stroke: {
                    ...node.stroke,
                    color: nextColor,
                    ...(node.stroke.paint
                      ? { paint: { type: "solid", color: nextColor } }
                      : {}),
                  },
                },
              },
            ],
          };
          break;
        }
        case "set-stroke-width":
          if (node.type === "group" || !node.stroke) {
            return failure(
              "precondition-failed",
              "Stroke width can only change an existing stroke on a leaf node.",
              actionIndex,
            );
          }
          if (node.stroke.width === action.width) {
            return failure(
              "no-op",
              "The requested stroke width is already set.",
              actionIndex,
            );
          }
          command = {
            type: "update-nodes",
            updates: [
              {
                nodeId: node.id,
                patch: {
                  stroke: { ...node.stroke, width: action.width },
                },
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
