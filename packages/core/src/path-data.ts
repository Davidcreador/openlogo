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
