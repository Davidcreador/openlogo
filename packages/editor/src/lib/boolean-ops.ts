import {
  type LogoNode,
  type PathNode,
  createId,
  getActiveArtboard,
} from "@openlogo/core";
import { type BooleanOp, combineNodes } from "@openlogo/renderer";
import { getCanvasKit } from "./canvaskit";
import { documentStore } from "../state/document";

const OP_LABELS: Record<BooleanOp, string> = {
  union: "Union",
  subtract: "Subtract",
  intersect: "Intersect",
  exclude: "Exclude",
};

/** Selected nodes that can participate in a boolean, in z-order. */
export function combinableNodes(selectedNodeIds: readonly string[]): LogoNode[] {
  const document = documentStore.document;
  const artboard = getActiveArtboard(document);
  const selected = new Set(selectedNodeIds);

  return artboard.nodeIds
    .filter((id) => selected.has(id))
    .map((id) => document.nodes[id])
    .filter(
      (node): node is LogoNode =>
        Boolean(node) && node!.type !== "text" && !node!.locked,
    );
}

/**
 * Replace the selected nodes with their boolean combination.
 * Returns the new node id, or null when the op was not possible.
 */
export async function applyBooleanOp(
  op: BooleanOp,
  selectedNodeIds: readonly string[],
): Promise<string | null> {
  const nodes = combinableNodes(selectedNodeIds);
  if (nodes.length < 2) {
    return null;
  }

  const ck = await getCanvasKit();
  const result = combineNodes(ck, nodes, op);
  if (!result) {
    return null;
  }

  const document = documentStore.document;
  const artboard = getActiveArtboard(document);
  const first = nodes[0]!;
  const removedIds = new Set(nodes.map((node) => node.id));

  // Insert where the bottom-most operand sat, in post-deletion indices.
  const firstIndex = artboard.nodeIds.indexOf(first.id);
  const insertIndex = artboard.nodeIds
    .slice(0, firstIndex)
    .filter((id) => !removedIds.has(id)).length;

  const pathNode: PathNode = {
    id: createId("node"),
    type: "path",
    name: OP_LABELS[op],
    x: result.x,
    y: result.y,
    width: result.width,
    height: result.height,
    rotation: 0,
    opacity: first.opacity,
    visible: true,
    locked: false,
    fill: structuredClone(first.fill),
    ...(first.stroke ? { stroke: { ...first.stroke } } : {}),
    d: result.d,
    intrinsicWidth: result.width,
    intrinsicHeight: result.height,
  };

  documentStore.apply({
    type: "batch",
    label: OP_LABELS[op],
    commands: [
      { type: "delete-nodes", nodeIds: [...removedIds] },
      {
        type: "insert-nodes",
        artboardId: artboard.id,
        nodes: [pathNode],
        index: insertIndex,
      },
    ],
  });

  return pathNode.id;
}
