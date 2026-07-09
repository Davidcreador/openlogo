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
  axis: "horizontal" | "vertical",
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
