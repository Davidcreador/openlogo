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
