import {
  type AlignEdge,
  type Bounds,
  type LogoDocument,
  type LogoNode,
  type NodePatch,
  type PathNode,
  alignUnitOffsets,
  collectLeafNodeIds,
  createId,
  distributeEvenGapOffsets,
  distributeSpacingOffsets,
  findContainerId,
  getActiveArtboard,
  getContainerChildIds,
  rotatePoint,
  unitBounds,
  visualBounds,
} from "@openlogo/core";
import { expandStroke } from "@openlogo/renderer";
import { getCanvasKit } from "./canvaskit";
import { applyTransform } from "./transform-ops";
import { recordTransform } from "./transform-again";
import { documentStore } from "../state/document";

type Unit = { id: string; bounds: Bounds };

export type ArrangePlacement = "front" | "forward" | "backward" | "back";

/**
 * Desired child order after arranging `selected` within one container.
 * Selected nodes keep their relative z-order; front/back jump the block
 * to the end/start, forward/backward step it one slot past the nearest
 * unselected neighbour.
 */
function arrangedOrder(
  list: readonly string[],
  selected: ReadonlySet<string>,
  placement: ArrangePlacement,
): string[] {
  const picked = list.filter((id) => selected.has(id));
  const rest = list.filter((id) => !selected.has(id));
  if (placement === "front") {
    return [...rest, ...picked];
  }
  if (placement === "back") {
    return [...picked, ...rest];
  }
  // Stepwise: walk items so no selected node swaps past another.
  const next = [...list];
  if (placement === "forward") {
    for (let i = next.length - 2; i >= 0; i -= 1) {
      if (selected.has(next[i]!) && !selected.has(next[i + 1]!)) {
        [next[i], next[i + 1]] = [next[i + 1]!, next[i]!];
      }
    }
  } else {
    for (let i = 1; i < next.length; i += 1) {
      if (selected.has(next[i]!) && !selected.has(next[i - 1]!)) {
        [next[i], next[i - 1]] = [next[i - 1]!, next[i]!];
      }
    }
  }
  return next;
}

/**
 * Move nodes within their containers' z-order as one undoable step.
 * Selected nodes keep their relative order; nodes from different
 * containers arrange independently. Returns false when nothing moves.
 */
export function arrangeNodes(
  nodeIds: readonly string[],
  placement: ArrangePlacement,
): boolean {
  const document = documentStore.document;
  const byContainer = new Map<string, Set<string>>();
  for (const nodeId of nodeIds) {
    const containerId = findContainerId(document, nodeId);
    if (containerId) {
      (
        byContainer.get(containerId) ??
        byContainer.set(containerId, new Set()).get(containerId)!
      ).add(nodeId);
    }
  }

  const commands: Array<{
    type: "reorder-node";
    containerId: string;
    nodeId: string;
    toIndex: number;
  }> = [];
  for (const [containerId, selected] of byContainer) {
    const list = getContainerChildIds(document, containerId);
    const target = arrangedOrder(list, selected, placement);
    // Emit moves that transform list into target: settle each slot in
    // order; reorder-node splices, so the working copy tracks state.
    const work = [...list];
    for (let i = 0; i < target.length; i += 1) {
      const nodeId = target[i]!;
      const from = work.indexOf(nodeId);
      if (from !== i) {
        work.splice(from, 1);
        work.splice(i, 0, nodeId);
        commands.push({ type: "reorder-node", containerId, nodeId, toIndex: i });
      }
    }
  }

  if (commands.length === 0) {
    return false;
  }
  if (commands.length === 1) {
    documentStore.apply(commands[0]!);
  } else {
    documentStore.apply({ type: "batch", commands, label: "Arrange" });
  }
  return true;
}


/**
 * Selection units: a group counts as one unit with derived bounds, so
 * align/distribute move whole groups instead of scattering children.
 */
function selectedUnits(
  nodeIds: readonly string[],
  boundsMode: "visual" | "unrotated" = "visual",
): Unit[] {
  const document = documentStore.document;
  return nodeIds
    .map((id) => {
      const node = document.nodes[id];
      if (!node || node.locked) {
        return null;
      }
      const bounds =
        boundsMode === "visual"
          ? visualBounds(document, id)
          : unitBounds(document, id);
      return bounds ? { id, bounds } : null;
    })
    .filter((unit): unit is Unit => unit !== null);
}

function unionBounds(units: Unit[]): Bounds | null {
  if (units.length === 0) {
    return null;
  }
  const minX = Math.min(...units.map((u) => u.bounds.x));
  const minY = Math.min(...units.map((u) => u.bounds.y));
  const maxX = Math.max(...units.map((u) => u.bounds.x + u.bounds.width));
  const maxY = Math.max(...units.map((u) => u.bounds.y + u.bounds.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Translation patches for every unlocked leaf under a unit. */
function translateUnit(
  document: LogoDocument,
  unitId: string,
  dx: number,
  dy: number,
): Array<{ nodeId: string; patch: NodePatch }> {
  if (dx === 0 && dy === 0) {
    return [];
  }
  return collectLeafNodeIds(document, [unitId])
    .map((nodeId) => {
      const node = document.nodes[nodeId];
      return node && !node.locked
        ? { nodeId, patch: { x: node.x + dx, y: node.y + dy } }
        : null;
    })
    .filter((update): update is NonNullable<typeof update> => update !== null);
}

/**
 * Align units. Multi-selection aligns within the selection bounds;
 * single selection aligns to the artboard (Illustrator's "align to
 * artboard" behaviour, which is what logo centring needs). With a key
 * object (`keyId` — a member of the selection marked by clicking it
 * again) everything aligns to the key's bounds and the key stays put.
 */
export function alignNodes(
  nodeIds: readonly string[],
  edge: AlignEdge,
  keyId?: string | null,
): void {
  const document = documentStore.document;
  const units = selectedUnits(nodeIds);
  if (units.length === 0) {
    return;
  }

  const keyUnit =
    units.length > 1 ? units.find((unit) => unit.id === keyId) : undefined;
  const artboard = getActiveArtboard(document);
  const offsets = alignUnitOffsets(
    units,
    edge,
    units.length === 1
      ? { x: 0, y: 0, width: artboard.width, height: artboard.height }
      : undefined,
    keyUnit?.id,
  );
  const updates = offsets.flatMap((offset) =>
    translateUnit(document, offset.id, offset.dx, offset.dy),
  );

  if (updates.length > 0) {
    documentStore.apply({ type: "update-nodes", updates });
  }
}

/** Evenly distribute gaps between 3+ units along an axis. */
export function distributeNodes(
  nodeIds: readonly string[],
  axis: "horizontal" | "vertical",
): void {
  const document = documentStore.document;
  const units = selectedUnits(nodeIds);
  if (units.length < 3) {
    return;
  }

  const offsets = distributeEvenGapOffsets(units, axis);
  const updates = offsets.flatMap((offset) =>
    translateUnit(document, offset.id, offset.dx, offset.dy),
  );

  if (updates.length > 0) {
    documentStore.apply({ type: "update-nodes", updates });
  }
}

/**
 * Distribute with an exact pixel gap between neighbouring units
 * (Illustrator "distribute spacing" with a value). The key object — or
 * the first unit along the axis — anchors and the rest chain off it.
 */
export function distributeNodesSpacing(
  nodeIds: readonly string[],
  axis: "horizontal" | "vertical",
  spacing: number,
  keyId?: string | null,
): void {
  const document = documentStore.document;
  const units = selectedUnits(nodeIds);
  const offsets = distributeSpacingOffsets(units, axis, spacing, keyId);
  const updates = offsets.flatMap((offset) =>
    translateUnit(document, offset.id, offset.dx, offset.dy),
  );
  if (updates.length > 0) {
    documentStore.apply({ type: "update-nodes", updates });
  }
}

/**
 * Mirror nodes across the selection centre. Shares reflectLeafPatches with
 * the Transform dialog so Flip / Reflect / ⌘D stay one code path.
 * "horizontal" = across the vertical mid-line (axis 90°);
 * "vertical" = across the horizontal mid-line (axis 0°).
 */
export function flipNodes(
  nodeIds: readonly string[],
  axis: "horizontal" | "vertical",
): void {
  const units = selectedUnits(nodeIds, "unrotated");
  const bounds = unionBounds(units);
  if (!bounds) {
    return;
  }
  const pivot = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  const spec = {
    kind: "reflect" as const,
    axisAngle: axis === "horizontal" ? 90 : 0,
    pivot,
  };
  if (applyTransform(nodeIds, spec, false)) {
    recordTransform({ ...spec, copy: false });
  }
}

/**
 * Radial repeat: place `count` copies of the node evenly rotated around
 * the artboard centre (badge/starburst construction). Leaf nodes only.
 */
export function rotateCopies(nodeId: string, count: number): string[] {
  const document = documentStore.document;
  const node = document.nodes[nodeId];
  if (!node || node.type === "group" || count < 2 || count > 64) {
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
 * The outline lands in the same container (group or top level).
 */
export async function expandStrokeOp(nodeId: string): Promise<string | null> {
  const document = documentStore.document;
  const node = document.nodes[nodeId];
  if (
    !node ||
    node.type === "text" ||
    node.type === "group" ||
    !node.stroke ||
    node.stroke.width <= 0
  ) {
    return null;
  }

  const ck = await getCanvasKit();
  const result = expandStroke(ck, node);
  if (!result) {
    return null;
  }

  const artboard = getActiveArtboard(documentStore.document);
  const containerId = findContainerId(document, node.id) ?? artboard.id;
  const index = getContainerChildIds(document, containerId).indexOf(node.id);

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
    fillRule: result.fillRule,
    geometry: result.geometry,
    intrinsicWidth: result.width,
    intrinsicHeight: result.height,
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
        ...(containerId !== artboard.id ? { containerId } : {}),
        nodes: [outline],
        index: index + 1,
      },
    ],
  });

  return outline.id;
}
