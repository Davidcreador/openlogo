import {
  type PathNode,
  createId,
  findContainerId,
  getActiveArtboard,
  getContainerChildIds,
} from "@openlogo/core";
import { offsetNodePath } from "@openlogo/renderer";
import { getCanvasKit } from "./canvaskit";
import { documentStore } from "../state/document";

/**
 * Offset Path (Illustrator semantics): produce a NEW path node whose
 * outline sits `amount` px outside (positive) or inside (negative) the
 * source node's outline; the original is untouched. See offsetNodePath
 * for the stroke-expand + PathOps construction and its join behaviour.
 * Returns the new node id, or null when the offset produces nothing
 * (zero amount, unsupported node, or an inset that swallows the shape).
 */
export async function offsetPathOp(
  nodeId: string,
  amount: number,
): Promise<string | null> {
  const document = documentStore.committedDocument;
  const generation = documentStore.documentGeneration;
  const node = document.nodes[nodeId];
  if (
    !node ||
    (node.type !== "path" && node.type !== "rectangle" && node.type !== "ellipse")
  ) {
    return null;
  }

  const ck = await getCanvasKit();
  const result = offsetNodePath(ck, node, amount);
  if (!result) {
    return null;
  }

  const current = documentStore.committedDocument;
  if (
    documentStore.documentGeneration !== generation ||
    current.activeArtboardId !== document.activeArtboardId ||
    current.nodes[nodeId] !== node
  ) {
    return null;
  }

  const artboard = getActiveArtboard(current);
  const containerId = findContainerId(document, node.id) ?? artboard.id;
  const index = getContainerChildIds(document, containerId).indexOf(node.id);

  const offset: PathNode = {
    id: createId("node"),
    type: "path",
    name: `${node.name} offset`,
    x: result.x,
    y: result.y,
    width: result.width,
    height: result.height,
    rotation: 0,
    opacity: node.opacity,
    visible: true,
    locked: false,
    fill: structuredClone(node.fill),
    ...(node.stroke ? { stroke: { ...node.stroke } } : {}),
    d: result.d,
    fillRule: result.fillRule,
    geometry: result.geometry,
    intrinsicWidth: result.width,
    intrinsicHeight: result.height,
  };

  documentStore.apply({
    type: "insert-nodes",
    artboardId: artboard.id,
    ...(containerId !== artboard.id ? { containerId } : {}),
    nodes: [offset],
    index: index + 1,
  });

  return offset.id;
}
