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
  const u = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0.5;

  let newFrom: PathPoint;
  let inserted: PathPoint;
  let newTo: PathPoint;

  if (!from.handleOut && !to.handleIn) {
    const point = lerp(from, to, u);
    newFrom = { ...from };
    inserted = { x: point.x, y: point.y };
    newTo = { ...to };
  } else {
    const c1 = from.handleOut ?? { x: from.x, y: from.y };
    const c2 = to.handleIn ?? { x: to.x, y: to.y };
    const q0 = lerp(from, c1, u);
    const q1 = lerp(c1, c2, u);
    const q2 = lerp(c2, to, u);
    const r0 = lerp(q0, q1, u);
    const r1 = lerp(q1, q2, u);
    const s = lerp(r0, r1, u);

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

/** Anchor address within a PathGeometry. */
export type AnchorRef = { subpath: number; index: number };

/** Averaging axis: horizontal → common y, vertical → common x. */
export type AverageAxis = "horizontal" | "vertical" | "both";

/** Two anchors closer than this weld into one on join. */
export const JOIN_WELD_TOLERANCE = 0.5;

/**
 * Retract both bezier handles so the anchor becomes a hard corner
 * (convert-anchor click on a smooth point). Null when the anchor does
 * not exist.
 */
export function setAnchorCorner(
  geometry: PathGeometry,
  subpathIndex: number,
  pointIndex: number,
): PathGeometry | null {
  const subpath = geometry.subpaths[subpathIndex];
  if (!subpath?.points[pointIndex]) {
    return null;
  }

  const points = subpath.points.map((point, index) =>
    index === pointIndex ? { x: point.x, y: point.y } : point,
  );
  const subpaths = [...geometry.subpaths];
  subpaths[subpathIndex] = { ...subpath, points };
  return { subpaths };
}

/**
 * Pull smooth handles out of a corner anchor (convert-anchor click on a
 * corner): handles run along the chord between the neighbouring anchors,
 * each a third of the distance to its neighbour — collinear (smooth),
 * not necessarily symmetric, which is the Illustrator conversion.
 */
export function setAnchorSmooth(
  geometry: PathGeometry,
  subpathIndex: number,
  pointIndex: number,
): PathGeometry | null {
  const subpath = geometry.subpaths[subpathIndex];
  const point = subpath?.points[pointIndex];
  if (!subpath || !point) {
    return null;
  }

  const count = subpath.points.length;
  const previous = subpath.closed
    ? subpath.points[(pointIndex - 1 + count) % count]
    : subpath.points[pointIndex - 1];
  const next = subpath.closed
    ? subpath.points[(pointIndex + 1) % count]
    : subpath.points[pointIndex + 1];
  if (!previous && !next) {
    return null;
  }

  const from = previous ?? point;
  const to = next ?? point;
  let dx = to.x - from.x;
  let dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) {
    dx = 1;
    dy = 0;
  } else {
    dx /= length;
    dy /= length;
  }

  const smooth: PathPoint = { x: point.x, y: point.y };
  if (previous) {
    const reach = Math.hypot(point.x - previous.x, point.y - previous.y) / 3;
    smooth.handleIn = { x: point.x - dx * reach, y: point.y - dy * reach };
  }
  if (next) {
    const reach = Math.hypot(next.x - point.x, next.y - point.y) / 3;
    smooth.handleOut = { x: point.x + dx * reach, y: point.y + dy * reach };
  }

  const points = subpath.points.map((item, index) =>
    index === pointIndex ? smooth : item,
  );
  const subpaths = [...geometry.subpaths];
  subpaths[subpathIndex] = { ...subpath, points };
  return { subpaths };
}

export type CutResult =
  /** A closed subpath opened at the anchor — still one path. */
  | { kind: "opened"; geometry: PathGeometry }
  /** An open subpath severed — the caller splits into two nodes. */
  | { kind: "split"; first: PathGeometry; second: PathGeometry };

/**
 * Scissors: cut a subpath at an anchor. A closed subpath opens there
 * (the anchor duplicates into the new start and end). An open subpath
 * severs at an interior anchor into two pieces: `first` keeps every
 * other subpath plus the leading half, `second` is the trailing half
 * alone. Cutting an open subpath at one of its endpoints is a no-op
 * (null).
 */
export function cutPathAt(
  geometry: PathGeometry,
  subpathIndex: number,
  pointIndex: number,
): CutResult | null {
  const subpath = geometry.subpaths[subpathIndex];
  const point = subpath?.points[pointIndex];
  if (!subpath || !point) {
    return null;
  }

  if (subpath.closed) {
    const rotated = [
      ...subpath.points.slice(pointIndex),
      ...subpath.points.slice(0, pointIndex),
    ];
    const start: PathPoint = {
      x: point.x,
      y: point.y,
      ...(point.handleOut ? { handleOut: point.handleOut } : {}),
    };
    const end: PathPoint = {
      x: point.x,
      y: point.y,
      ...(point.handleIn ? { handleIn: point.handleIn } : {}),
    };
    const points = [start, ...rotated.slice(1), end];
    const subpaths = [...geometry.subpaths];
    subpaths[subpathIndex] = { closed: false, points };
    return { kind: "opened", geometry: { subpaths } };
  }

  if (pointIndex === 0 || pointIndex === subpath.points.length - 1) {
    return null;
  }

  const leading: PathPoint = {
    x: point.x,
    y: point.y,
    ...(point.handleIn ? { handleIn: point.handleIn } : {}),
  };
  const trailing: PathPoint = {
    x: point.x,
    y: point.y,
    ...(point.handleOut ? { handleOut: point.handleOut } : {}),
  };
  const firstHalf: SubPath = {
    closed: false,
    points: [...subpath.points.slice(0, pointIndex), leading],
  };
  const secondHalf: SubPath = {
    closed: false,
    points: [trailing, ...subpath.points.slice(pointIndex + 1)],
  };

  const firstSubpaths = [...geometry.subpaths];
  firstSubpaths[subpathIndex] = firstHalf;
  return {
    kind: "split",
    first: { subpaths: firstSubpaths },
    second: { subpaths: [secondHalf] },
  };
}

/** True when the ref addresses the first or last anchor of an OPEN subpath. */
export function isOpenEndpoint(
  geometry: PathGeometry,
  ref: AnchorRef,
): boolean {
  const subpath = geometry.subpaths[ref.subpath];
  if (!subpath || subpath.closed || subpath.points.length < 2) {
    return false;
  }
  return ref.index === 0 || ref.index === subpath.points.length - 1;
}

function reverseSubPath(subpath: SubPath): SubPath {
  return {
    closed: subpath.closed,
    points: [...subpath.points].reverse().map((point) => ({
      x: point.x,
      y: point.y,
      ...(point.handleOut ? { handleIn: point.handleOut } : {}),
      ...(point.handleIn ? { handleOut: point.handleIn } : {}),
    })),
  };
}

/**
 * Join two open-subpath endpoint anchors (⌘J).
 *
 * Same subpath → the subpath closes; when its two ends are coincident
 * (within JOIN_WELD_TOLERANCE) the duplicate anchor welds away first.
 * Different subpaths → they merge into one open subpath, reoriented so
 * the selected anchors meet; coincident anchors weld, otherwise a
 * straight segment connects them. Null when either ref is not an open
 * endpoint (or a weld would degenerate the subpath).
 */
export function joinAnchors(
  geometry: PathGeometry,
  a: AnchorRef,
  b: AnchorRef,
): PathGeometry | null {
  if (!isOpenEndpoint(geometry, a) || !isOpenEndpoint(geometry, b)) {
    return null;
  }

  if (a.subpath === b.subpath) {
    if (a.index === b.index) {
      return null;
    }
    const subpath = geometry.subpaths[a.subpath]!;
    const first = subpath.points[0]!;
    const last = subpath.points[subpath.points.length - 1]!;
    const coincident =
      Math.hypot(first.x - last.x, first.y - last.y) <= JOIN_WELD_TOLERANCE;

    let points = subpath.points;
    if (coincident) {
      if (points.length - 1 < 3) {
        return null; // closing a welded 2-point subpath degenerates
      }
      const welded: PathPoint = {
        ...first,
        ...(last.handleIn ? { handleIn: last.handleIn } : {}),
      };
      points = [welded, ...points.slice(1, -1)];
    } else if (points.length < 3) {
      return null; // closing a 2-point line back onto itself
    }

    const subpaths = [...geometry.subpaths];
    subpaths[a.subpath] = { closed: true, points };
    return { subpaths };
  }

  // Cross-subpath: orient A to END at its anchor, B to START at its.
  let source = geometry.subpaths[a.subpath]!;
  let target = geometry.subpaths[b.subpath]!;
  if (a.index === 0) {
    source = reverseSubPath(source);
  }
  if (b.index !== 0) {
    target = reverseSubPath(target);
  }

  const tail = source.points[source.points.length - 1]!;
  const head = target.points[0]!;
  const coincident =
    Math.hypot(tail.x - head.x, tail.y - head.y) <= JOIN_WELD_TOLERANCE;

  const points = coincident
    ? [
        ...source.points.slice(0, -1),
        {
          ...tail,
          ...(head.handleOut ? { handleOut: head.handleOut } : {}),
        },
        ...target.points.slice(1),
      ]
    : [...source.points, ...target.points];

  const subpaths = geometry.subpaths
    .map((item, index) =>
      index === a.subpath ? { closed: false, points } : item,
    )
    .filter((_, index) => index !== b.subpath);
  return { subpaths };
}

/**
 * Average (⌥⌘J): move the referenced anchors (handles riding along) to
 * their mean — a common point, a common y (horizontal) or a common x
 * (vertical). Null when fewer than two valid anchors are referenced.
 */
export function averageAnchors(
  geometry: PathGeometry,
  refs: readonly AnchorRef[],
  axis: AverageAxis,
): PathGeometry | null {
  const anchors = refs
    .map((ref) => geometry.subpaths[ref.subpath]?.points[ref.index])
    .filter((point): point is PathPoint => Boolean(point));
  if (anchors.length < 2) {
    return null;
  }

  const meanX = anchors.reduce((sum, p) => sum + p.x, 0) / anchors.length;
  const meanY = anchors.reduce((sum, p) => sum + p.y, 0) / anchors.length;
  const targeted = new Map<string, true>();
  for (const ref of refs) {
    targeted.set(`${ref.subpath}:${ref.index}`, true);
  }

  const subpaths = geometry.subpaths.map((subpath, si) => ({
    closed: subpath.closed,
    points: subpath.points.map((point, pi) => {
      if (!targeted.has(`${si}:${pi}`)) {
        return point;
      }
      const dx = axis === "horizontal" ? 0 : meanX - point.x;
      const dy = axis === "vertical" ? 0 : meanY - point.y;
      if (dx === 0 && dy === 0) {
        return point;
      }
      return {
        x: point.x + dx,
        y: point.y + dy,
        ...(point.handleIn
          ? { handleIn: { x: point.handleIn.x + dx, y: point.handleIn.y + dy } }
          : {}),
        ...(point.handleOut
          ? {
              handleOut: {
                x: point.handleOut.x + dx,
                y: point.handleOut.y + dy,
              },
            }
          : {}),
      };
    }),
  }));
  return { subpaths };
}

/**
 * Generic absolute path command, the shape emitted by font engines
 * (opentype.js) and SVG parsers. Quadratics are converted to cubics so
 * everything downstream deals with one curve type.
 */
export type PathCommand =
  | { type: "M"; x: number; y: number }
  | { type: "L"; x: number; y: number }
  | { type: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: "Q"; x1: number; y1: number; x: number; y: number }
  | { type: "Z" };

export function commandsToGeometry(commands: PathCommand[]): PathGeometry {
  const subpaths: SubPath[] = [];
  let points: PathPoint[] = [];

  const flush = (closed: boolean) => {
    if (points.length > 0) {
      // Closed contours often repeat the first point; drop the duplicate.
      if (closed && points.length > 1) {
        const first = points[0]!;
        const last = points[points.length - 1]!;
        if (
          Math.abs(first.x - last.x) < 1e-6 &&
          Math.abs(first.y - last.y) < 1e-6
        ) {
          if (last.handleIn) {
            first.handleIn = last.handleIn;
          }
          points.pop();
        }
      }
      if (points.length > 1) {
        subpaths.push({ closed, points });
      }
      points = [];
    }
  };

  for (const command of commands) {
    switch (command.type) {
      case "M":
        flush(false);
        points.push({ x: command.x, y: command.y });
        break;

      case "L":
        points.push({ x: command.x, y: command.y });
        break;

      case "C": {
        const previous = points[points.length - 1];
        if (previous) {
          previous.handleOut = { x: command.x1, y: command.y1 };
        }
        points.push({
          x: command.x,
          y: command.y,
          handleIn: { x: command.x2, y: command.y2 },
        });
        break;
      }

      case "Q": {
        // Exact quadratic → cubic elevation: c1 = p0 + 2/3(q - p0),
        // c2 = p1 + 2/3(q - p1).
        const previous = points[points.length - 1];
        if (!previous) {
          break;
        }
        const c1 = {
          x: previous.x + (2 / 3) * (command.x1 - previous.x),
          y: previous.y + (2 / 3) * (command.y1 - previous.y),
        };
        const c2 = {
          x: command.x + (2 / 3) * (command.x1 - command.x),
          y: command.y + (2 / 3) * (command.y1 - command.y),
        };
        previous.handleOut = c1;
        points.push({ x: command.x, y: command.y, handleIn: c2 });
        break;
      }

      case "Z":
        flush(true);
        break;
    }
  }

  flush(false);
  return { subpaths };
}

/**
 * Convert CanvasKit's flattened `Path.toCmds()` representation into editable
 * geometry. CanvasKit verbs are move, line, quad, conic, cubic, and close
 * (0–5), followed by their absolute coordinates.
 *
 * Conics have no exact cubic representation in the general case. Their
 * control handles use Skia's standard single-cubic approximation; a unit
 * weight reduces to the exact quadratic elevation.
 */
export function pathCommandsToGeometry(
  commands: ArrayLike<number>,
): PathGeometry | null {
  const length = commands.length;
  if (!Number.isSafeInteger(length) || length <= 0) {
    return null;
  }

  const subpaths: SubPath[] = [];
  let points: PathPoint[] | null = null;
  let offset = 0;

  const flush = (closed: boolean) => {
    if (!points) {
      return;
    }

    // CanvasKit may retain an explicit final point at the contour origin.
    // Closing already supplies that segment, so keep one editable anchor.
    if (closed && points.length > 1) {
      const first = points[0]!;
      const last = points[points.length - 1]!;
      if (
        Math.abs(first.x - last.x) < 1e-6 &&
        Math.abs(first.y - last.y) < 1e-6
      ) {
        if (last.handleIn) {
          first.handleIn = last.handleIn;
        }
        points.pop();
      }
    }

    if (points.length > 1) {
      subpaths.push({ points, closed });
    }
    points = null;
  };

  while (offset < length) {
    const verb = commands[offset];
    offset += 1;

    let argumentCount: number;
    switch (verb) {
      case 0:
      case 1:
        argumentCount = 2;
        break;
      case 2:
        argumentCount = 4;
        break;
      case 3:
        argumentCount = 5;
        break;
      case 4:
        argumentCount = 6;
        break;
      case 5:
        argumentCount = 0;
        break;
      default:
        return null;
    }

    if (offset + argumentCount > length) {
      return null;
    }
    for (let index = 0; index < argumentCount; index += 1) {
      if (!Number.isFinite(commands[offset + index])) {
        return null;
      }
    }

    switch (verb) {
      case 0:
        flush(false);
        points = [
          {
            x: commands[offset]!,
            y: commands[offset + 1]!,
          },
        ];
        break;

      case 1:
        if (!points) {
          return null;
        }
        points.push({
          x: commands[offset]!,
          y: commands[offset + 1]!,
        });
        break;

      case 2: {
        if (!points) {
          return null;
        }
        const previous = points[points.length - 1]!;
        const controlX = commands[offset]!;
        const controlY = commands[offset + 1]!;
        const x = commands[offset + 2]!;
        const y = commands[offset + 3]!;
        const handleOut = {
          x: previous.x + (2 / 3) * (controlX - previous.x),
          y: previous.y + (2 / 3) * (controlY - previous.y),
        };
        const handleIn = {
          x: x + (2 / 3) * (controlX - x),
          y: y + (2 / 3) * (controlY - y),
        };
        if (
          !Number.isFinite(handleOut.x) ||
          !Number.isFinite(handleOut.y) ||
          !Number.isFinite(handleIn.x) ||
          !Number.isFinite(handleIn.y)
        ) {
          return null;
        }
        previous.handleOut = handleOut;
        points.push({ x, y, handleIn });
        break;
      }

      case 3: {
        if (!points) {
          return null;
        }
        const previous = points[points.length - 1]!;
        const controlX = commands[offset]!;
        const controlY = commands[offset + 1]!;
        const x = commands[offset + 2]!;
        const y = commands[offset + 3]!;
        const weight = commands[offset + 4]!;
        const denominator = 3 * (1 + weight);
        if (!Number.isFinite(denominator) || denominator <= 0) {
          return null;
        }
        const alpha = (4 * weight) / denominator;
        if (!Number.isFinite(alpha)) {
          return null;
        }
        const handleOut = {
          x: previous.x + alpha * (controlX - previous.x),
          y: previous.y + alpha * (controlY - previous.y),
        };
        const handleIn = {
          x: x + alpha * (controlX - x),
          y: y + alpha * (controlY - y),
        };
        if (
          !Number.isFinite(handleOut.x) ||
          !Number.isFinite(handleOut.y) ||
          !Number.isFinite(handleIn.x) ||
          !Number.isFinite(handleIn.y)
        ) {
          return null;
        }
        previous.handleOut = handleOut;
        points.push({ x, y, handleIn });
        break;
      }

      case 4: {
        if (!points) {
          return null;
        }
        const previous = points[points.length - 1]!;
        previous.handleOut = {
          x: commands[offset]!,
          y: commands[offset + 1]!,
        };
        points.push({
          x: commands[offset + 4]!,
          y: commands[offset + 5]!,
          handleIn: {
            x: commands[offset + 2]!,
            y: commands[offset + 3]!,
          },
        });
        break;
      }

      case 5:
        if (!points) {
          return null;
        }
        flush(true);
        break;
    }

    offset += argumentCount;
  }

  flush(false);
  return subpaths.length > 0 ? { subpaths } : null;
}

/**
 * Reverse every subpath's direction: points in reverse order with
 * handleIn/handleOut swapped. Walking the reversed path forward is
 * identical to walking the original backward — this is what "flip" on
 * text-on-a-path means, and what the SVG export uses so a flipped
 * <textPath> renders without SVG2's poorly-supported side="right".
 */
export function reversePathGeometry(geometry: PathGeometry): PathGeometry {
  return {
    subpaths: geometry.subpaths.map((subpath) => ({
      closed: subpath.closed,
      points: [...subpath.points].reverse().map((point) => ({
        x: point.x,
        y: point.y,
        ...(point.handleOut ? { handleIn: point.handleOut } : {}),
        ...(point.handleIn ? { handleOut: point.handleIn } : {}),
      })),
    })),
  };
}

const LENGTH_SAMPLES = 64;

/**
 * Approximate total arc length by sampling each segment. `sx`/`sy` scale
 * the geometry first (a path node's intrinsic → rendered space), because
 * non-uniform scaling has no closed-form effect on length.
 */
export function pathGeometryLength(
  geometry: PathGeometry,
  sx = 1,
  sy = 1,
): number {
  let total = 0;

  for (const subpath of geometry.subpaths) {
    const count = subpath.points.length;
    const segments = subpath.closed ? count : count - 1;

    for (let i = 0; i < segments; i += 1) {
      const from = subpath.points[i]!;
      const to = subpath.points[(i + 1) % count]!;
      let prev = { x: from.x * sx, y: from.y * sy };
      for (let s = 1; s <= LENGTH_SAMPLES; s += 1) {
        const point = segmentPointAt(from, to, s / LENGTH_SAMPLES);
        const scaled = { x: point.x * sx, y: point.y * sy };
        total += Math.hypot(scaled.x - prev.x, scaled.y - prev.y);
        prev = scaled;
      }
    }
  }

  return total;
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
