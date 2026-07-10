import {
  type LogoNode,
  type PathNode,
  collectLeafNodeIds,
  createId,
  expandDeletionSet,
  getAncestorGroupIds,
  getActiveArtboard,
} from "@openlogo/core";
import { type BooleanOp, combineNodes } from "@openlogo/renderer";
import { getCanvasKit } from "./canvaskit";
import { sortBySceneOrder } from "./group-ops";
import { documentStore } from "../state/document";

const OP_LABELS: Record<BooleanOp, string> = {
  union: "Union",
  subtract: "Subtract",
  intersect: "Intersect",
  exclude: "Exclude",
};

/**
 * Selected shapes that can participate in a boolean, in scene z-order.
 * Groups contribute their leaf shapes (the boolean flattens them).
 */
export function combinableNodes(selectedNodeIds: readonly string[]): LogoNode[] {
  const document = documentStore.document;
  const leafIds = collectLeafNodeIds(
    document,
    sortBySceneOrder(document, selectedNodeIds),
  );
  // Boolean/Shape Builder results currently replace operands. Operating
  // inside a clipping group could orphan its owner or flatten a masked
  // subtree, so users must release the mask first.
  if (
    leafIds.some((id) =>
      getAncestorGroupIds(document, id).some((groupId) => {
        const group = document.nodes[groupId];
        return group?.type === "group" && group.clippingMaskId !== undefined;
      }),
    )
  ) {
    return [];
  }
  return leafIds
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
  // Deleting operands also prunes any groups the deletion empties.
  const removedIds = new Set(
    expandDeletionSet(
      document,
      nodes.map((node) => node.id),
    ),
  );

  // Insert where the bottom-most operand's top-level unit sat, in
  // post-deletion indices (operands may live inside groups).
  const firstTopIndex = artboard.nodeIds.findIndex(
    (id) =>
      removedIds.has(id) ||
      collectLeafNodeIds(document, [id]).some((leafId) =>
        removedIds.has(leafId),
      ),
  );
  const insertIndex = artboard.nodeIds
    .slice(0, Math.max(0, firstTopIndex))
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
    fillRule: result.fillRule,
    geometry: result.geometry,
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
