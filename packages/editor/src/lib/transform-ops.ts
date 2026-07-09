import {
  type LeafUpdate,
  type LogoDocument,
  type LogoNode,
  type Vec2,
  findContainerId,
  getActiveArtboard,
  reflectLeafPatches,
  rotateLeafPatches,
  scaleLeafPatches,
  translateLeafPatches,
} from "@openlogo/core";
import { cloneUnits } from "./group-ops";
import { documentStore } from "../state/document";

/**
 * A transform the editor can apply to a selection — and repeat via
 * Transform Again. Pivots are artboard-local and absolute, which is
 * what makes repeated ⌘D rotations trace a radial array around one
 * point, Illustrator-style.
 */
export type TransformSpec =
  | { kind: "move"; dx: number; dy: number }
  | { kind: "rotate"; degrees: number; pivot: Vec2 }
  | { kind: "reflect"; axisAngle: number; pivot: Vec2 }
  | { kind: "scale"; sx: number; sy: number; pivot: Vec2 };

function patchesFor(
  document: LogoDocument,
  nodeIds: readonly string[],
  spec: TransformSpec,
): LeafUpdate[] {
  switch (spec.kind) {
    case "move":
      return translateLeafPatches(document, nodeIds, spec.dx, spec.dy);
    case "rotate":
      return rotateLeafPatches(document, nodeIds, spec.degrees, spec.pivot);
    case "reflect":
      return reflectLeafPatches(document, nodeIds, spec.axisAngle, spec.pivot);
    case "scale":
      return scaleLeafPatches(document, nodeIds, spec.sx, spec.sy, spec.pivot);
  }
}

/**
 * Apply a transform to the selection as ONE undoable command. With
 * `copy` the originals stay put: the selection's unit subtrees clone,
 * the transform lands on the clones in-memory, and a single
 * insert-nodes commits them. Returns the ids to select next (clone
 * roots, or the input ids), or null when nothing was transformable.
 */
export function applyTransform(
  nodeIds: readonly string[],
  spec: TransformSpec,
  copy: boolean,
): string[] | null {
  const document = documentStore.document;
  const presentIds = nodeIds.filter((id) => document.nodes[id]);
  if (presentIds.length === 0) {
    return null;
  }

  if (!copy) {
    const updates = patchesFor(document, presentIds, spec);
    if (updates.length === 0) {
      return null;
    }
    documentStore.apply({ type: "update-nodes", updates });
    return [...presentIds];
  }

  const { nodes, rootIds } = cloneUnits(document, presentIds);
  if (nodes.length === 0) {
    return null;
  }

  // Compute patches against a synthetic document containing the clones,
  // then bake them into the clone objects — the insert is then a single
  // plain command and its inverse a plain delete.
  const synthetic: LogoDocument = {
    ...document,
    nodes: {
      ...document.nodes,
      ...Object.fromEntries(nodes.map((node) => [node.id, node])),
    },
  };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const update of patchesFor(synthetic, rootIds, spec)) {
    const clone = byId.get(update.nodeId);
    if (clone) {
      Object.assign(clone, update.patch as Partial<LogoNode>);
    }
  }

  const artboard = getActiveArtboard(document);
  const containerId = findContainerId(document, presentIds[0]!);
  const container =
    containerId && document.nodes[containerId]?.type === "group"
      ? containerId
      : undefined;

  documentStore.apply({
    type: "insert-nodes",
    artboardId: artboard.id,
    ...(container ? { containerId: container } : {}),
    nodes,
  });
  return rootIds;
}
