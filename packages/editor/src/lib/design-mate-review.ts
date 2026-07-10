import {
  collectLeafNodeIds,
  selectionFrame,
  type LogoDocument,
  type ReviewFinding,
  type ReviewScope,
} from "@openlogo/core";
import type {
  DesignMateSelection,
  DocumentIdentity,
} from "@openlogo/design-mate";

export type CurrentDocumentHead = {
  documentId: string;
  generation: number;
  revision: number;
};

export type DesignMateRequestSignature = {
  scope: ReviewScope;
  selectedNodeIds: string[];
  keyObjectId?: string;
  activeGroupId?: string;
};

export type DesignMateFocusTarget =
  | {
      type: "nodes";
      nodeIds: string[];
      artboardId?: string;
      bounds: { x: number; y: number; width: number; height: number };
    }
  | {
      type: "artboard";
      artboardId: string;
      bounds: { x: number; y: number; width: number; height: number };
    };

export function isDesignMateReviewStale(
  identity: DocumentIdentity,
  current: CurrentDocumentHead,
): boolean {
  return (
    identity.documentId !== current.documentId ||
    identity.generation !== current.generation ||
    identity.revision !== current.revision
  );
}

export function createDesignMateRequestSignature(
  scope: ReviewScope,
  selection: DesignMateSelection,
): DesignMateRequestSignature {
  return {
    scope,
    selectedNodeIds: [...new Set(selection.selectedNodeIds)].sort(),
    ...(selection.keyObjectId ? { keyObjectId: selection.keyObjectId } : {}),
    ...(selection.activeGroupId
      ? { activeGroupId: selection.activeGroupId }
      : {}),
  };
}

export function designMateRequestSignaturesEqual(
  left: DesignMateRequestSignature,
  right: DesignMateRequestSignature,
): boolean {
  if (left.scope !== right.scope) {
    return false;
  }
  // Selection metadata cannot affect artboard/system reviews. Ignoring it
  // keeps those results current while the user navigates the canvas.
  if (left.scope !== "selection") {
    return true;
  }
  return (
    left.keyObjectId === right.keyObjectId &&
    left.activeGroupId === right.activeGroupId &&
    left.selectedNodeIds.length === right.selectedNodeIds.length &&
    left.selectedNodeIds.every(
      (nodeId, index) => nodeId === right.selectedNodeIds[index],
    )
  );
}

/**
 * Resolve a finding into a non-mutating camera target. Node references win so
 * "Show on canvas" does not need to switch the active artboard (a persistent
 * document command that would immediately make the review stale).
 */
export function resolveDesignMateFocus(
  document: LogoDocument,
  finding: ReviewFinding,
): DesignMateFocusTarget | null {
  const nodeIds = [
    ...new Set(
      (finding.nodeIds ?? []).filter(
        (nodeId) => document.nodes[nodeId] !== undefined,
      ),
    ),
  ];
  if (nodeIds.length > 0) {
    const frame = selectionFrame(document, nodeIds);
    if (frame) {
      const artboard =
        (finding.artboardId
          ? document.artboards.find(
              (item) => item.id === finding.artboardId,
            )
          : undefined) ??
        document.artboards.find((item) =>
          nodeIds.some((nodeId) =>
            collectLeafNodeIds(document, item.nodeIds).includes(nodeId),
          ),
        );
      return {
        type: "nodes",
        nodeIds,
        bounds: artboard
          ? {
              x: frame.bounds.x + artboard.x,
              y: frame.bounds.y + artboard.y,
              width: frame.bounds.width,
              height: frame.bounds.height,
            }
          : frame.bounds,
        ...(artboard ? { artboardId: artboard.id } : {}),
      };
    }
  }

  const artboard = finding.artboardId
    ? document.artboards.find((item) => item.id === finding.artboardId)
    : undefined;
  return artboard
    ? {
        type: "artboard",
        artboardId: artboard.id,
        bounds: {
          x: artboard.x,
          y: artboard.y,
          width: artboard.width,
          height: artboard.height,
        },
      }
    : null;
}
