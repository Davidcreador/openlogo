import type { Bounds } from "./geometry";

/**
 * Smart-guide snapping. Pure: caller supplies the moving bounds and the
 * static candidate bounds (other nodes + the artboard itself) in the same
 * coordinate space, plus a world-space threshold (screen px / zoom).
 */

export type SnapGuide = {
  axis: "x" | "y";
  /** World coordinate of the guide line. */
  position: number;
  /** Extent of the line along the other axis. */
  start: number;
  end: number;
};

export type SnapResult = {
  dx: number;
  dy: number;
  guides: SnapGuide[];
};

type Edge = {
  value: number;
  /** Extent of the source box along the other axis. */
  start: number;
  end: number;
};

function edgesOf(bounds: Bounds, axis: "x" | "y"): Edge[] {
  if (axis === "x") {
    const start = bounds.y;
    const end = bounds.y + bounds.height;
    return [
      { value: bounds.x, start, end },
      { value: bounds.x + bounds.width / 2, start, end },
      { value: bounds.x + bounds.width, start, end },
    ];
  }
  const start = bounds.x;
  const end = bounds.x + bounds.width;
  return [
    { value: bounds.y, start, end },
    { value: bounds.y + bounds.height / 2, start, end },
    { value: bounds.y + bounds.height, start, end },
  ];
}

function bestSnapForAxis(
  moving: Bounds,
  targets: Bounds[],
  axis: "x" | "y",
  threshold: number,
): { delta: number; guides: SnapGuide[] } {
  const movingEdges = edgesOf(moving, axis);
  let bestDelta = Infinity;

  for (const target of targets) {
    for (const targetEdge of edgesOf(target, axis)) {
      for (const movingEdge of movingEdges) {
        const delta = targetEdge.value - movingEdge.value;
        if (
          Math.abs(delta) <= threshold &&
          Math.abs(delta) < Math.abs(bestDelta)
        ) {
          bestDelta = delta;
        }
      }
    }
  }

  if (!Number.isFinite(bestDelta)) {
    return { delta: 0, guides: [] };
  }

  // After moving by bestDelta, collect every aligned target edge as a guide.
  const guides: SnapGuide[] = [];
  const seen = new Set<number>();
  const snappedEdges = movingEdges.map((edge) => ({
    ...edge,
    value: edge.value + bestDelta,
  }));

  for (const target of targets) {
    for (const targetEdge of edgesOf(target, axis)) {
      for (const movingEdge of snappedEdges) {
        if (Math.abs(targetEdge.value - movingEdge.value) < 0.01) {
          const key = Math.round(targetEdge.value * 100);
          if (!seen.has(key)) {
            seen.add(key);
            guides.push({
              axis,
              position: targetEdge.value,
              start: Math.min(targetEdge.start, movingEdge.start),
              end: Math.max(targetEdge.end, movingEdge.end),
            });
          }
        }
      }
    }
  }

  return { delta: bestDelta, guides };
}

/**
 * Snap a single edge value (resize drags move one edge, not the box).
 * Returns the delta to apply and the matched guide, if any.
 */
export function snapValue(
  value: number,
  extent: { start: number; end: number },
  targets: Bounds[],
  axis: "x" | "y",
  threshold: number,
): { delta: number; guide: SnapGuide | null } {
  let bestDelta = Infinity;
  let bestEdge: Edge | null = null;

  for (const target of targets) {
    for (const targetEdge of edgesOf(target, axis)) {
      const delta = targetEdge.value - value;
      if (
        Math.abs(delta) <= threshold &&
        Math.abs(delta) < Math.abs(bestDelta)
      ) {
        bestDelta = delta;
        bestEdge = targetEdge;
      }
    }
  }

  if (!bestEdge || !Number.isFinite(bestDelta)) {
    return { delta: 0, guide: null };
  }

  return {
    delta: bestDelta,
    guide: {
      axis,
      position: bestEdge.value,
      start: Math.min(bestEdge.start, extent.start),
      end: Math.max(bestEdge.end, extent.end),
    },
  };
}

export function computeSnap(
  moving: Bounds,
  targets: Bounds[],
  threshold: number,
): SnapResult {
  const x = bestSnapForAxis(moving, targets, "x", threshold);
  const y = bestSnapForAxis(moving, targets, "y", threshold);

  return {
    dx: x.delta,
    dy: y.delta,
    guides: [...x.guides, ...y.guides],
  };
}

/* ------------------------------------------------------------------ *
 * Distance readouts + equal-spacing snapping (Figma-style).
 * ------------------------------------------------------------------ */

/** A measured gap between two object edges, for on-canvas readouts. */
export type MeasureSegment = {
  /** Axis the distance is measured along. */
  axis: "x" | "y";
  /** Segment endpoints along `axis` (from <= to). */
  from: number;
  to: number;
  /** Position on the perpendicular axis (midline of the boxes' overlap). */
  cross: number;
  /** Gap size: to - from. */
  distance: number;
};

export type SpacingSnap = {
  /** Delta to apply along the axis so the gaps become equal. */
  delta: number;
  /** The equal gap segments to indicate, at the snapped position. */
  gaps: MeasureSegment[];
};

/** A box projected onto one axis, keeping its perpendicular extent. */
type Span = {
  lo: number;
  hi: number;
  crossLo: number;
  crossHi: number;
};

function spanOf(bounds: Bounds, axis: "x" | "y"): Span {
  return axis === "x"
    ? {
        lo: bounds.x,
        hi: bounds.x + bounds.width,
        crossLo: bounds.y,
        crossHi: bounds.y + bounds.height,
      }
    : {
        lo: bounds.y,
        hi: bounds.y + bounds.height,
        crossLo: bounds.x,
        crossHi: bounds.x + bounds.width,
      };
}

function crossOverlap(a: Span, b: Span): number {
  return Math.min(a.crossHi, b.crossHi) - Math.max(a.crossLo, b.crossLo);
}

function crossMid(a: Span, b: Span): number {
  return (Math.max(a.crossLo, b.crossLo) + Math.min(a.crossHi, b.crossHi)) / 2;
}

/**
 * Candidates that can flank the moving box: solid boxes (ruler guides are
 * zero-thickness lines and never measure) overlapping it on the cross
 * axis. Containers (artboard) drop out later because they are never
 * disjoint from the moving box along the axis.
 */
function flankCandidates(
  moving: Span,
  targets: Bounds[],
  axis: "x" | "y",
): Span[] {
  const spans: Span[] = [];
  for (const bounds of targets) {
    if (bounds.width <= 0 || bounds.height <= 0) {
      continue;
    }
    const span = spanOf(bounds, axis);
    if (crossOverlap(span, moving) > 0) {
      spans.push(span);
    }
  }
  return spans;
}

function segment(
  axis: "x" | "y",
  from: number,
  to: number,
  cross: number,
): MeasureSegment {
  return { axis, from, to, cross, distance: to - from };
}

/**
 * Equal-spacing snap along one axis. Candidates are pruned to the four
 * relevant neighbours — the nearest cross-overlapping box on each side of
 * the moving centre (L, R) and each one's own next neighbour outward
 * (L2, R2) — giving at most three candidate positions: centred between
 * L and R, extending the row after L with the L2→L gap, and extending
 * before R with the R→R2 gap. The closest candidate within the threshold
 * wins.
 */
export function computeSpacingSnap(
  moving: Bounds,
  targets: Bounds[],
  axis: "x" | "y",
  threshold: number,
): SpacingSnap | null {
  const m = spanOf(moving, axis);
  const size = m.hi - m.lo;
  const center = (m.lo + m.hi) / 2;
  const spans = flankCandidates(m, targets, axis);

  let left: Span | null = null;
  let right: Span | null = null;
  for (const span of spans) {
    if (span.hi <= center && (!left || span.hi > left.hi)) {
      left = span;
    }
    if (span.lo >= center && (!right || span.lo < right.lo)) {
      right = span;
    }
  }

  // Outward neighbours must form a row with L/R (cross overlap between
  // themselves, not just with the moving box).
  let left2: Span | null = null;
  let right2: Span | null = null;
  for (const span of spans) {
    if (
      left &&
      span.hi <= left.lo &&
      crossOverlap(span, left) > 0 &&
      (!left2 || span.hi > left2.hi)
    ) {
      left2 = span;
    }
    if (
      right &&
      span.lo >= right.hi &&
      crossOverlap(span, right) > 0 &&
      (!right2 || span.lo < right2.lo)
    ) {
      right2 = span;
    }
  }

  type Candidate = { lo: number; gaps: (lo: number) => MeasureSegment[] };
  const candidates: Candidate[] = [];

  if (left && right) {
    const l = left;
    const r = right;
    const gap = (r.lo - l.hi - size) / 2;
    if (gap >= 0) {
      candidates.push({
        lo: l.hi + gap,
        gaps: (lo) => [
          segment(axis, l.hi, lo, crossMid(l, m)),
          segment(axis, lo + size, r.lo, crossMid(m, r)),
        ],
      });
    }
  }

  if (left && left2) {
    const l = left;
    const l2 = left2;
    const gap = l.lo - l2.hi;
    if (gap > 0) {
      candidates.push({
        lo: l.hi + gap,
        gaps: (lo) => [
          segment(axis, l2.hi, l.lo, crossMid(l2, l)),
          segment(axis, l.hi, lo, crossMid(l, m)),
        ],
      });
    }
  }

  if (right && right2) {
    const r = right;
    const r2 = right2;
    const gap = r2.lo - r.hi;
    if (gap > 0) {
      candidates.push({
        lo: r.lo - gap - size,
        gaps: (lo) => [
          segment(axis, lo + size, r.lo, crossMid(m, r)),
          segment(axis, r.hi, r2.lo, crossMid(r, r2)),
        ],
      });
    }
  }

  let best: Candidate | null = null;
  let bestDelta = Infinity;
  for (const candidate of candidates) {
    const delta = candidate.lo - m.lo;
    if (Math.abs(delta) <= threshold && Math.abs(delta) < Math.abs(bestDelta)) {
      bestDelta = delta;
      best = candidate;
    }
  }

  if (!best) {
    return null;
  }
  return { delta: bestDelta, gaps: best.gaps(best.lo) };
}

/**
 * Pixel distances from the moving box to its nearest neighbour on each
 * side (Figma-style readouts while snapped). Neighbours must overlap the
 * moving box on the cross axis and be fully clear of it along the axis;
 * ruler-guide lines and containers never measure.
 */
export function measureDistances(
  moving: Bounds,
  targets: Bounds[],
): MeasureSegment[] {
  const out: MeasureSegment[] = [];

  for (const axis of ["x", "y"] as const) {
    const m = spanOf(moving, axis);
    let left: Span | null = null;
    let right: Span | null = null;

    for (const span of flankCandidates(m, targets, axis)) {
      if (span.hi <= m.lo && (!left || span.hi > left.hi)) {
        left = span;
      }
      if (span.lo >= m.hi && (!right || span.lo < right.lo)) {
        right = span;
      }
    }

    if (left && m.lo - left.hi > 0.01) {
      out.push(segment(axis, left.hi, m.lo, crossMid(left, m)));
    }
    if (right && right.lo - m.hi > 0.01) {
      out.push(segment(axis, m.hi, right.lo, crossMid(m, right)));
    }
  }

  return out;
}
