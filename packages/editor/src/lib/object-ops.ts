import {
  type Bounds,
  type LogoDocument,
  type LogoNode,
  type NodePatch,
  type PathNode,
  collectLeafNodeIds,
  createId,
  distributeSpacingOffsets,
  findContainerId,
  getActiveArtboard,
  getContainerChildIds,
  pathGeometryToSvg,
  rotatePoint,
  scalePathGeometry,
  translatePathGeometry,
  unitBounds,
} from "@openlogo/core";
import { expandStroke } from "@openlogo/renderer";
import { getCanvasKit } from "./canvaskit";
import { recordTransform } from "./transform-again";
import { documentStore } from "../state/document";

export type AlignEdge =
  | "left"
  | "centerX"
  | "right"
  | "top"
  | "centerY"
  | "bottom";

type Unit = { id: string; bounds: Bounds };

/**
 * Selection units: a group counts as one unit with derived bounds, so
 * align/distribute move whole groups instead of scattering children.
 */
function selectedUnits(nodeIds: readonly string[]): Unit[] {
  const document = documentStore.document;
  return nodeIds
    .map((id) => {
      const node = document.nodes[id];
      if (!node || node.locked) {
        return null;
      }
      const bounds = unitBounds(document, id);
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
  const reference = keyUnit
    ? keyUnit.bounds
    : units.length > 1
      ? unionBounds(units)!
      : { x: 0, y: 0, width: artboard.width, height: artboard.height };

  const movable = keyUnit
    ? units.filter((unit) => unit.id !== keyUnit.id)
    : units;
  const updates = movable.flatMap((unit) => {
    let dx = 0;
    let dy = 0;
    switch (edge) {
      case "left":
        dx = reference.x - unit.bounds.x;
        break;
      case "centerX":
        dx =
          reference.x +
          (reference.width - unit.bounds.width) / 2 -
          unit.bounds.x;
        break;
      case "right":
        dx = reference.x + reference.width - unit.bounds.width - unit.bounds.x;
        break;
      case "top":
        dy = reference.y - unit.bounds.y;
        break;
      case "centerY":
        dy =
          reference.y +
          (reference.height - unit.bounds.height) / 2 -
          unit.bounds.y;
        break;
      case "bottom":
        dy =
          reference.y + reference.height - unit.bounds.height - unit.bounds.y;
        break;
    }
    return translateUnit(document, unit.id, dx, dy);
  });

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

  const horizontal = axis === "horizontal";
  const sorted = [...units].sort((a, b) =>
    horizontal ? a.bounds.x - b.bounds.x : a.bounds.y - b.bounds.y,
  );
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const span = horizontal
    ? last.bounds.x + last.bounds.width - first.bounds.x
    : last.bounds.y + last.bounds.height - first.bounds.y;
  const totalSize = sorted.reduce(
    (sum, unit) => sum + (horizontal ? unit.bounds.width : unit.bounds.height),
    0,
  );
  const gap = (span - totalSize) / (sorted.length - 1);

  let cursor = horizontal ? first.bounds.x : first.bounds.y;
  const updates = sorted.flatMap((unit) => {
    const dx = horizontal ? cursor - unit.bounds.x : 0;
    const dy = horizontal ? 0 : cursor - unit.bounds.y;
    cursor += (horizontal ? unit.bounds.width : unit.bounds.height) + gap;
    return translateUnit(document, unit.id, dx, dy);
  });

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

/** Mirror nodes across the selection bounds (content mirrored for paths). */
export function flipNodes(
  nodeIds: readonly string[],
  axis: "horizontal" | "vertical",
): void {
  const document = documentStore.document;
  const units = selectedUnits(nodeIds);
  const bounds = unionBounds(units);
  if (!bounds) {
    return;
  }

  // Mirroring every leaf across the shared bounds also mirrors a
  // group's internal arrangement, which is the Illustrator behaviour.
  const leaves = collectLeafNodeIds(
    document,
    units.map((unit) => unit.id),
  )
    .map((id) => document.nodes[id])
    .filter(
      (node): node is LogoNode => Boolean(node) && !node!.locked,
    );

  const horizontal = axis === "horizontal";
  const updates = leaves.map((node) => {
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
  // A flip is a reflect: "horizontal" mirrors across the vertical line
  // through the selection centre (axis 90°), "vertical" across the
  // horizontal one (axis 0°). ⌘D repeats it.
  recordTransform({
    kind: "reflect",
    axisAngle: horizontal ? 90 : 0,
    pivot: {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    },
    copy: false,
  });
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
