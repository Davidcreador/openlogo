import { type Bounds, boundsUnion, rotatedBounds } from "./geometry";
import type { Artboard, LogoDocument, LogoNode } from "./types";

export function getActiveArtboard(document: LogoDocument): Artboard {
  const active = document.artboards.find(
    (artboard) => artboard.id === document.activeArtboardId,
  );

  if (!active) {
    throw new Error("Active artboard is missing from the document.");
  }

  return active;
}

export function getNodesForArtboard(
  document: LogoDocument,
  artboardId = document.activeArtboardId,
): LogoNode[] {
  const artboard = document.artboards.find((item) => item.id === artboardId);

  if (!artboard) {
    return [];
  }

  return artboard.nodeIds
    .map((id) => document.nodes[id])
    .filter((node): node is LogoNode => Boolean(node));
}

export function nodeBounds(node: LogoNode): Bounds {
  return rotatedBounds(
    { x: node.x, y: node.y, width: node.width, height: node.height },
    node.rotation,
  );
}

export function getSelectionBounds(
  document: LogoDocument,
  selectedNodeIds: readonly string[],
): Bounds | null {
  const list = selectedNodeIds
    .map((id) => document.nodes[id])
    .filter((node): node is LogoNode => Boolean(node))
    .map(nodeBounds);

  return boundsUnion(list);
}
