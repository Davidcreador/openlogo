import type { NodePatch } from "./commands";
import type { Bounds } from "./geometry";

/**
 * Precision helpers: pixel snapping and exact-spacing distribution.
 * Both are pure — the editor decides when they apply (pixel snap is a
 * committed-change concern, never a preview one).
 */

/**
 * Round the geometric fields of a patch to whole pixels. Only fields
 * present in the patch are touched (an absent `x` must stay absent so
 * the command's inverse stays exact); dimensions keep the schema's
 * positive invariant by never rounding below 1.
 */
export function pixelSnapPatch(patch: NodePatch): NodePatch {
  const snapped: NodePatch = { ...patch };
  if (snapped.x !== undefined) {
    snapped.x = Math.round(snapped.x);
  }
  if (snapped.y !== undefined) {
    snapped.y = Math.round(snapped.y);
  }
  if (snapped.width !== undefined) {
    snapped.width = Math.max(1, Math.round(snapped.width));
  }
  if (snapped.height !== undefined) {
    snapped.height = Math.max(1, Math.round(snapped.height));
  }
  return snapped;
}

export type SpacingUnit = {
  id: string;
  bounds: Bounds;
};

export type SpacingOffset = {
  id: string;
  dx: number;
  dy: number;
};

export type AlignEdge =
  | "left"
  | "centerX"
  | "right"
  | "top"
  | "centerY"
  | "bottom";

export type LayoutAxis = "horizontal" | "vertical";

function validBounds(bounds: Bounds): boolean {
  return (
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width >= 0 &&
    bounds.height >= 0
  );
}

function unionUnitBounds(units: readonly SpacingUnit[]): Bounds | null {
  if (units.length === 0 || units.some((unit) => !validBounds(unit.bounds))) {
    return null;
  }
  const minX = Math.min(...units.map((unit) => unit.bounds.x));
  const minY = Math.min(...units.map((unit) => unit.bounds.y));
  const maxX = Math.max(
    ...units.map((unit) => unit.bounds.x + unit.bounds.width),
  );
  const maxY = Math.max(
    ...units.map((unit) => unit.bounds.y + unit.bounds.height),
  );
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Align layout units to an explicit reference, their union, or a key object.
 * The key object stays fixed. Zero-delta entries are omitted.
 */
export function alignUnitOffsets(
  units: readonly SpacingUnit[],
  edge: AlignEdge,
  reference?: Bounds,
  anchorId?: string | null,
): SpacingOffset[] {
  if (
    units.length === 0 ||
    (reference !== undefined && !validBounds(reference))
  ) {
    return [];
  }
  const anchor =
    units.length > 1 && anchorId
      ? units.find((unit) => unit.id === anchorId)
      : undefined;
  const target = anchor?.bounds ?? reference ?? unionUnitBounds(units);
  if (!target || !validBounds(target)) {
    return [];
  }

  const offsets: SpacingOffset[] = [];
  for (const unit of anchor
    ? units.filter((candidate) => candidate.id !== anchor.id)
    : units) {
    if (!validBounds(unit.bounds)) {
      return [];
    }
    let dx = 0;
    let dy = 0;
    switch (edge) {
      case "left":
        dx = target.x - unit.bounds.x;
        break;
      case "centerX":
        dx =
          target.x +
          (target.width - unit.bounds.width) / 2 -
          unit.bounds.x;
        break;
      case "right":
        dx =
          target.x + target.width - unit.bounds.width - unit.bounds.x;
        break;
      case "top":
        dy = target.y - unit.bounds.y;
        break;
      case "centerY":
        dy =
          target.y +
          (target.height - unit.bounds.height) / 2 -
          unit.bounds.y;
        break;
      case "bottom":
        dy =
          target.y + target.height - unit.bounds.height - unit.bounds.y;
        break;
    }
    if (dx !== 0 || dy !== 0) {
      offsets.push({ id: unit.id, dx, dy });
    }
  }
  return offsets;
}

/**
 * Evenly distribute the gaps between three or more units. The first and last
 * units in positional order remain fixed; zero-delta entries are omitted.
 */
export function distributeEvenGapOffsets(
  units: readonly SpacingUnit[],
  axis: LayoutAxis,
): SpacingOffset[] {
  if (
    units.length < 3 ||
    units.some((unit) => !validBounds(unit.bounds))
  ) {
    return [];
  }
  const horizontal = axis === "horizontal";
  const position = (unit: SpacingUnit) =>
    horizontal ? unit.bounds.x : unit.bounds.y;
  const size = (unit: SpacingUnit) =>
    horizontal ? unit.bounds.width : unit.bounds.height;
  const sorted = [...units].sort(
    (left, right) => position(left) - position(right),
  );
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const span = position(last) + size(last) - position(first);
  const totalSize = sorted.reduce((sum, unit) => sum + size(unit), 0);
  const gap = (span - totalSize) / (sorted.length - 1);

  let cursor = position(first);
  const offsets: SpacingOffset[] = [];
  for (const unit of sorted) {
    const delta = cursor - position(unit);
    if (delta !== 0) {
      offsets.push({
        id: unit.id,
        dx: horizontal ? delta : 0,
        dy: horizontal ? 0 : delta,
      });
    }
    cursor += size(unit) + gap;
  }
  return offsets;
}

/**
 * Distribute units along an axis with an EXACT gap between neighbouring
 * bounds (Illustrator's "distribute spacing" with a value). Units are
 * processed in positional order; the anchor unit (the key object when
 * given, else the first along the axis) keeps its position and the rest
 * chain off it in both directions. Returns per-unit translations —
 * zero-delta entries are omitted. Needs 2+ units.
 */
export function distributeSpacingOffsets(
  units: readonly SpacingUnit[],
  axis: LayoutAxis,
  spacing: number,
  anchorId?: string | null,
): SpacingOffset[] {
  if (units.length < 2 || !Number.isFinite(spacing)) {
    return [];
  }

  const horizontal = axis === "horizontal";
  const pos = (unit: SpacingUnit) =>
    horizontal ? unit.bounds.x : unit.bounds.y;
  const size = (unit: SpacingUnit) =>
    horizontal ? unit.bounds.width : unit.bounds.height;

  const sorted = [...units].sort((a, b) => pos(a) - pos(b));
  const anchorIndex = Math.max(
    0,
    sorted.findIndex((unit) => unit.id === anchorId),
  );

  const targets = new Array<number>(sorted.length);
  targets[anchorIndex] = pos(sorted[anchorIndex]!);
  for (let i = anchorIndex + 1; i < sorted.length; i += 1) {
    targets[i] = targets[i - 1]! + size(sorted[i - 1]!) + spacing;
  }
  for (let i = anchorIndex - 1; i >= 0; i -= 1) {
    targets[i] = targets[i + 1]! - spacing - size(sorted[i]!);
  }

  const offsets: SpacingOffset[] = [];
  sorted.forEach((unit, i) => {
    const delta = targets[i]! - pos(unit);
    if (delta !== 0) {
      offsets.push({
        id: unit.id,
        dx: horizontal ? delta : 0,
        dy: horizontal ? 0 : delta,
      });
    }
  });
  return offsets;
}
