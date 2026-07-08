import {
  type Bounds,
  type LogoNode,
  type NodePatch,
  type PathNode,
  createId,
  getActiveArtboard,
  pathGeometryToSvg,
  rotatePoint,
  scalePathGeometry,
  translatePathGeometry,
} from "@openlogo/core";
import { expandStroke } from "@openlogo/renderer";
import { getCanvasKit } from "./canvaskit";
import { documentStore } from "../state/document";

export type AlignEdge =
  | "left"
  | "centerX"
  | "right"
  | "top"
  | "centerY"
  | "bottom";

function selectedNodes(nodeIds: readonly string[]): LogoNode[] {
  const document = documentStore.document;
  return nodeIds
    .map((id) => document.nodes[id])
    .filter((node): node is LogoNode => Boolean(node) && !node!.locked);
}

function selectionBounds(nodes: LogoNode[]): Bounds | null {
  if (nodes.length === 0) {
    return null;
  }
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.width));
  const maxY = Math.max(...nodes.map((n) => n.y + n.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Align nodes. Multi-selection aligns within the selection bounds;
 * single selection aligns to the artboard (Illustrator's "align to
 * artboard" behaviour, which is what logo centring needs).
 */
export function alignNodes(nodeIds: readonly string[], edge: AlignEdge): void {
  const nodes = selectedNodes(nodeIds);
  if (nodes.length === 0) {
    return;
  }

  const artboard = getActiveArtboard(documentStore.document);
  const reference =
    nodes.length > 1
      ? selectionBounds(nodes)!
      : { x: 0, y: 0, width: artboard.width, height: artboard.height };

  const updates = nodes.map((node) => {
    const patch: NodePatch = {};
    switch (edge) {
      case "left":
        patch.x = reference.x;
        break;
      case "centerX":
        patch.x = reference.x + (reference.width - node.width) / 2;
        break;
      case "right":
        patch.x = reference.x + reference.width - node.width;
        break;
      case "top":
        patch.y = reference.y;
        break;
      case "centerY":
        patch.y = reference.y + (reference.height - node.height) / 2;
        break;
      case "bottom":
        patch.y = reference.y + reference.height - node.height;
        break;
    }
    return { nodeId: node.id, patch };
  });

  documentStore.apply({ type: "update-nodes", updates });
}

/** Evenly distribute gaps between 3+ nodes along an axis. */
export function distributeNodes(
  nodeIds: readonly string[],
  axis: "horizontal" | "vertical",
): void {
  const nodes = selectedNodes(nodeIds);
  if (nodes.length < 3) {
    return;
  }

  const horizontal = axis === "horizontal";
  const sorted = [...nodes].sort((a, b) =>
    horizontal ? a.x - b.x : a.y - b.y,
  );
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const span = horizontal
    ? last.x + last.width - first.x
    : last.y + last.height - first.y;
  const totalSize = sorted.reduce(
    (sum, node) => sum + (horizontal ? node.width : node.height),
    0,
  );
  const gap = (span - totalSize) / (sorted.length - 1);

  let cursor = horizontal ? first.x : first.y;
  const updates = sorted.map((node) => {
    const patch: NodePatch = horizontal ? { x: cursor } : { y: cursor };
    cursor += (horizontal ? node.width : node.height) + gap;
    return { nodeId: node.id, patch };
  });

  documentStore.apply({ type: "update-nodes", updates });
}

/** Mirror nodes across the selection bounds (content mirrored for paths). */
export function flipNodes(
  nodeIds: readonly string[],
  axis: "horizontal" | "vertical",
): void {
  const nodes = selectedNodes(nodeIds);
  const bounds = selectionBounds(nodes);
  if (!bounds) {
    return;
  }

  const horizontal = axis === "horizontal";
  const updates = nodes.map((node) => {
    const patch: NodePatch = {};

    if (horizontal) {
      patch.x = 2 * bounds.x + bounds.width - (node.x + node.width);
    } else {
      patch.y = 2 * bounds.y + bounds.height - (node.y + node.height);
    }
    if (node.rotation !== 0) {
      patch.rotation = -node.rotation;
    }

    if (node.type === "path" && node.geometry) {
      const mirrored = translatePathGeometry(
        scalePathGeometry(
          node.geometry,
          horizontal ? -1 : 1,
          horizontal ? 1 : -1,
        ),
        horizontal ? node.intrinsicWidth : 0,
        horizontal ? 0 : node.intrinsicHeight,
      );
      patch.geometry = mirrored;
      patch.d = pathGeometryToSvg(mirrored);
    }

    return { nodeId: node.id, patch };
  });

  documentStore.apply({ type: "update-nodes", updates });
}

/**
 * Radial repeat: place `count` copies of the node evenly rotated around
 * the artboard centre (badge/starburst construction).
 */
export function rotateCopies(nodeId: string, count: number): string[] {
  const document = documentStore.document;
  const node = document.nodes[nodeId];
  if (!node || count < 2 || count > 64) {
    return [];
  }

  const artboard = getActiveArtboard(document);
  const pivot = { x: artboard.width / 2, y: artboard.height / 2 };
  const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  const clones: LogoNode[] = [];

  for (let i = 1; i < count; i += 1) {
    const angle = (360 / count) * i;
    const nextCenter = rotatePoint(center, pivot, angle);
    clones.push({
      ...structuredClone(node),
      id: createId("node"),
      name: `${node.name} ${i + 1}`,
      x: nextCenter.x - node.width / 2,
      y: nextCenter.y - node.height / 2,
      rotation: node.rotation + angle,
    });
  }

  documentStore.apply({
    type: "insert-nodes",
    artboardId: document.activeArtboardId,
    nodes: clones,
  });

  return clones.map((clone) => clone.id);
}

/**
 * Outline the stroke into its own filled path node above the original
 * (Illustrator "Outline Stroke"); the original keeps only its fill.
 */
export async function expandStrokeOp(nodeId: string): Promise<string | null> {
  const document = documentStore.document;
  const node = document.nodes[nodeId];
  if (!node || node.type === "text" || !node.stroke || node.stroke.width <= 0) {
    return null;
  }

  const ck = await getCanvasKit();
  const result = expandStroke(ck, node);
  if (!result) {
    return null;
  }

  const artboard = getActiveArtboard(documentStore.document);
  const index = artboard.nodeIds.indexOf(node.id);

  const outline: PathNode = {
    id: createId("node"),
    type: "path",
    name: `${node.name} stroke`,
    x: result.x,
    y: result.y,
    width: result.width,
    height: result.height,
    rotation: 0,
    opacity: node.opacity,
    visible: true,
    locked: false,
    fill: { type: "solid", color: node.stroke.color },
    d: result.d,
    intrinsicWidth: result.width,
    intrinsicHeight: result.height,
    ...(node.groupId ? { groupId: node.groupId } : {}),
  };

  documentStore.apply({
    type: "batch",
    label: "Expand stroke",
    commands: [
      {
        type: "update-nodes",
        updates: [{ nodeId, patch: { stroke: undefined } }],
      },
      {
        type: "insert-nodes",
        artboardId: artboard.id,
        nodes: [outline],
        index: index + 1,
      },
    ],
  });

  return outline.id;
}
