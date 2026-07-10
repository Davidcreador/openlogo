import {
  selectionFrame,
  type LogoDocument,
  type ReviewFinding,
} from "@openlogo/core";
import type { DocumentIdentity } from "@openlogo/design-mate";

export type CurrentDocumentHead = {
  documentId: string;
  generation: number;
  revision: number;
};

export type DesignMateFocusTarget =
  | {
      type: "nodes";
      nodeIds: string[];
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
      return { type: "nodes", nodeIds, bounds: frame.bounds };
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
