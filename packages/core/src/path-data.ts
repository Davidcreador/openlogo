import type { Bounds, Vec2 } from "./geometry";

/**
 * Structured, editable path geometry. This is the pen tool's source of
 * truth; the SVG `d` string on a PathNode is derived from it. Paths
 * without geometry (imported/legacy `d` strings) are not node-editable.
 *
 * Coordinates are in the node's intrinsic space (same space as `d`).
 * Handles are absolute positions, not deltas.
 */

export type PathPoint = {
  x: number;
  y: number;
  /** Incoming bezier handle (from the previous segment). */
  handleIn?: Vec2;
  /** Outgoing bezier handle (towards the next segment). */
  handleOut?: Vec2;
};

export type SubPath = {
  points: PathPoint[];
  closed: boolean;
};

export type PathGeometry = {
  subpaths: SubPath[];
};

function segment(from: PathPoint, to: PathPoint): string {
  if (from.handleOut || to.handleIn) {
    const c1 = from.handleOut ?? { x: from.x, y: from.y };
    const c2 = to.handleIn ?? { x: to.x, y: to.y };
    return `C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y}`;
  }
  return `L ${to.x} ${to.y}`;
}

export function pathGeometryToSvg(geometry: PathGeometry): string {
  const parts: string[] = [];

  for (const subpath of geometry.subpaths) {
    const points = subpath.points;
    if (points.length === 0) {
      continue;
    }

    const first = points[0]!;
    parts.push(`M ${first.x} ${first.y}`);

    for (let i = 1; i < points.length; i += 1) {
      parts.push(segment(points[i - 1]!, points[i]!));
    }

    if (subpath.closed && points.length > 1) {
      parts.push(segment(points[points.length - 1]!, first));
      parts.push("Z");
    }
  }

  return parts.join(" ");
}

/**
 * Bounding box over anchors and handles (control-point hull). Slightly
 * loose for strong curves; callers with CanvasKit available can refine
 * via Path.computeTightBounds.
 */
export function pathGeometryBounds(geometry: PathGeometry): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const include = (point: Vec2) => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  };

  for (const subpath of geometry.subpaths) {
    for (const point of subpath.points) {
      include(point);
      if (point.handleIn) {
        include(point.handleIn);
      }
      if (point.handleOut) {
        include(point.handleOut);
      }
    }
  }

  if (!Number.isFinite(minX)) {
    return null;
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, 0.01),
    height: Math.max(maxY - minY, 0.01),
  };
}

export function translatePathGeometry(
  geometry: PathGeometry,
  dx: number,
  dy: number,
): PathGeometry {
  return mapPathGeometry(geometry, (point) => ({
    x: point.x + dx,
    y: point.y + dy,
  }));
}

export function scalePathGeometry(
  geometry: PathGeometry,
  sx: number,
  sy: number,
): PathGeometry {
  return mapPathGeometry(geometry, (point) => ({
    x: point.x * sx,
    y: point.y * sy,
  }));
}

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

type SegmentRef = {
  subpath: number;
  /** Segment from points[index] to points[(index+1) % length]. */
  index: number;
  t: number;
  point: Vec2;
  distance: number;
};

function segmentPointAt(from: PathPoint, to: PathPoint, t: number): Vec2 {
  if (!from.handleOut && !to.handleIn) {
    return lerp(from, to, t);
  }
  const c1 = from.handleOut ?? { x: from.x, y: from.y };
  const c2 = to.handleIn ?? { x: to.x, y: to.y };
  const q0 = lerp(from, c1, t);
  const q1 = lerp(c1, c2, t);
  const q2 = lerp(c2, to, t);
  const r0 = lerp(q0, q1, t);
  const r1 = lerp(q1, q2, t);
  return lerp(r0, r1, t);
}

/**
 * Closest point on any segment within `tolerance` of `target`.
 * Coarse sampling plus local refinement — plenty for hit-testing.
 */
export function findSegmentNear(
  geometry: PathGeometry,
  target: Vec2,
  tolerance: number,
): SegmentRef | null {
  let best: SegmentRef | null = null;

  for (const [si, subpath] of geometry.subpaths.entries()) {
    const count = subpath.points.length;
    const segments = subpath.closed ? count : count - 1;

    for (let i = 0; i < segments; i += 1) {
      const from = subpath.points[i]!;
      const to = subpath.points[(i + 1) % count]!;

      // Coarse scan.
      let bestT = 0;
      let bestDist = Infinity;
      const SAMPLES = 32;
      for (let s = 0; s <= SAMPLES; s += 1) {
        const t = s / SAMPLES;
        const point = segmentPointAt(from, to, t);
        const dist = Math.hypot(point.x - target.x, point.y - target.y);
        if (dist < bestDist) {
          bestDist = dist;
          bestT = t;
        }
      }

      // Local refinement.
      let step = 1 / SAMPLES / 2;
      for (let iter = 0; iter < 20; iter += 1) {
        for (const t of [bestT - step, bestT + step]) {
          if (t < 0 || t > 1) {
            continue;
          }
          const point = segmentPointAt(from, to, t);
          const dist = Math.hypot(point.x - target.x, point.y - target.y);
          if (dist < bestDist) {
            bestDist = dist;
            bestT = t;
          }
        }
        step /= 2;
      }

      if (bestDist <= tolerance && (!best || bestDist < best.distance)) {
        best = {
          subpath: si,
          index: i,
          t: bestT,
          point: segmentPointAt(from, to, bestT),
          distance: bestDist,
        };
      }
    }
  }

  return best;
}

/**
 * Split a segment at parameter t, inserting a new anchor. Cubic segments
 * split with de Casteljau so the curve shape is preserved exactly;
 * straight segments insert a plain corner point. Returns new geometry and
 * the inserted point's index.
 */
export function insertAnchor(
  geometry: PathGeometry,
  subpathIndex: number,
  segmentIndex: number,
  t: number,
): { geometry: PathGeometry; index: number } | null {
  const subpath = geometry.subpaths[subpathIndex];
  if (!subpath) {
    return null;
  }

  const count = subpath.points.length;
  const from = subpath.points[segmentIndex];
  const to = subpath.points[(segmentIndex + 1) % count];
  if (!from || !to) {
    return null;
  }

  let newFrom: PathPoint;
  let inserted: PathPoint;
  let newTo: PathPoint;

  if (!from.handleOut && !to.handleIn) {
    const point = lerp(from, to, t);
    newFrom = { ...from };
    inserted = { x: point.x, y: point.y };
    newTo = { ...to };
  } else {
    const c1 = from.handleOut ?? { x: from.x, y: from.y };
    const c2 = to.handleIn ?? { x: to.x, y: to.y };
    const q0 = lerp(from, c1, t);
    const q1 = lerp(c1, c2, t);
    const q2 = lerp(c2, to, t);
    const r0 = lerp(q0, q1, t);
    const r1 = lerp(q1, q2, t);
    const s = lerp(r0, r1, t);

    newFrom = { ...from, handleOut: q0 };
    inserted = { x: s.x, y: s.y, handleIn: r0, handleOut: r1 };
    newTo = { ...to, handleIn: q2 };
  }

  const points = [...subpath.points];
  points[segmentIndex] = newFrom;
  points[(segmentIndex + 1) % count] = newTo;
  points.splice(segmentIndex + 1, 0, inserted);

  const subpaths = [...geometry.subpaths];
  subpaths[subpathIndex] = { ...subpath, points };

  return { geometry: { subpaths }, index: segmentIndex + 1 };
}

/**
 * Remove an anchor. Subpaths that fall below 2 points are dropped;
 * returns null when the whole geometry would become empty (caller should
 * delete the node instead).
 */
export function removeAnchor(
  geometry: PathGeometry,
  subpathIndex: number,
  pointIndex: number,
): PathGeometry | null {
  const subpath = geometry.subpaths[subpathIndex];
  if (!subpath || !subpath.points[pointIndex]) {
    return null;
  }

  const points = subpath.points.filter((_, index) => index !== pointIndex);
  const subpaths = [...geometry.subpaths];

  if (points.length < 2) {
    subpaths.splice(subpathIndex, 1);
  } else {
    subpaths[subpathIndex] = { ...subpath, points };
  }

  if (subpaths.every((item) => item.points.length === 0) || subpaths.length === 0) {
    return null;
  }

  return { subpaths };
}

function mapPathGeometry(
  geometry: PathGeometry,
  transform: (point: Vec2) => Vec2,
): PathGeometry {
  return {
    subpaths: geometry.subpaths.map((subpath) => ({
      closed: subpath.closed,
      points: subpath.points.map((point) => {
        const anchor = transform(point);
        return {
          x: anchor.x,
          y: anchor.y,
          ...(point.handleIn ? { handleIn: transform(point.handleIn) } : {}),
          ...(point.handleOut ? { handleOut: transform(point.handleOut) } : {}),
        };
      }),
    })),
  };
}
