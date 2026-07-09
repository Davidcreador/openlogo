import type { NodePatch } from "./commands";
import type { Bounds, Vec2 } from "./geometry";
import { createId } from "./id";
import {
  type PathGeometry,
  pathGeometryBounds,
  pathGeometryToSvg,
  translatePathGeometry,
} from "./path-data";
import type { PathNode, ShapeParams, Stroke } from "./types";

/**
 * Shape library: parametric shapes stored as PathNodes with a `shape`
 * param block. Triangle/polygon/star are "box" shapes generated inside a
 * width×height box; line/arrow are "vector" shapes generated from a
 * drag vector. Regenerating from params goes through `shapeParamsPatch`.
 */

export const DEFAULT_POLYGON_SIDES = 6;
export const DEFAULT_STAR_POINTS = 5;
export const DEFAULT_STAR_INNER_RATIO = 0.45;
export const MIN_SHAPE_SIDES = 3;
export const MAX_SHAPE_SIDES = 60;

const SHAPE_NAMES: Record<ShapeParams["kind"], string> = {
  triangle: "Triangle",
  polygon: "Polygon",
  star: "Star",
  line: "Line",
  arrow: "Arrow",
};

export function shapeDisplayName(kind: ShapeParams["kind"]): string {
  return SHAPE_NAMES[kind];
}

/** Clamp params into their valid ranges (sides integral, ratio 0.05–0.95). */
export function clampShapeParams(shape: ShapeParams): ShapeParams {
  const next: ShapeParams = { kind: shape.kind };
  if (shape.kind === "polygon" || shape.kind === "star") {
    const fallback =
      shape.kind === "polygon" ? DEFAULT_POLYGON_SIDES : DEFAULT_STAR_POINTS;
    next.sides = Math.min(
      MAX_SHAPE_SIDES,
      Math.max(MIN_SHAPE_SIDES, Math.round(shape.sides ?? fallback)),
    );
  }
  if (shape.kind === "star") {
    next.innerRatio = Math.min(
      0.95,
      Math.max(0.05, shape.innerRatio ?? DEFAULT_STAR_INNER_RATIO),
    );
  }
  return next;
}

/** Vertex ring of a regular n-gon on the unit circle, first vertex up. */
function polygonRing(sides: number): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
    points.push({ x: Math.cos(angle), y: Math.sin(angle) });
  }
  return points;
}

/** Alternating outer/inner ring of a star, first spike up. */
function starRing(spikes: number, innerRatio: number): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i < spikes * 2; i += 1) {
    const radius = i % 2 === 0 ? 1 : innerRatio;
    const angle = -Math.PI / 2 + (i * Math.PI) / spikes;
    points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return points;
}

/** Rescale a vertex ring so its bounds are exactly (0,0)–(width,height). */
function fitRingToBox(ring: Vec2[], width: number, height: number): Vec2[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of ring) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  return ring.map((point) => ({
    x: ((point.x - minX) / spanX) * width,
    y: ((point.y - minY) / spanY) * height,
  }));
}

function closedGeometry(ring: Vec2[]): PathGeometry {
  return {
    subpaths: [
      { closed: true, points: ring.map((point) => ({ x: point.x, y: point.y })) },
    ],
  };
}

/**
 * Geometry of a box shape (triangle/polygon/star), normalized so its
 * bounds fill (0,0)–(width,height) exactly — node box === geometry box.
 * Returns null for the vector kinds (line/arrow).
 */
export function shapeGeometryInBox(
  shape: ShapeParams,
  width: number,
  height: number,
): PathGeometry | null {
  const params = clampShapeParams(shape);
  switch (params.kind) {
    case "triangle":
      return closedGeometry([
        { x: width / 2, y: 0 },
        { x: width, y: height },
        { x: 0, y: height },
      ]);
    case "polygon":
      return closedGeometry(
        fitRingToBox(polygonRing(params.sides!), width, height),
      );
    case "star":
      return closedGeometry(
        fitRingToBox(starRing(params.sides!, params.innerRatio!), width, height),
      );
    default:
      return null;
  }
}

/**
 * Geometry of a vector shape (line/arrow) between two points, in the
 * caller's coordinate space (not normalized). Returns null for box kinds.
 */
export function shapeGeometryFromVector(
  shape: ShapeParams,
  from: Vec2,
  to: Vec2,
): PathGeometry | null {
  if (shape.kind === "line") {
    return {
      subpaths: [
        {
          closed: false,
          points: [
            { x: from.x, y: from.y },
            { x: to.x, y: to.y },
          ],
        },
      ],
    };
  }

  if (shape.kind !== "arrow") {
    return null;
  }

  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length < 1e-6) {
    return null;
  }
  const ux = (to.x - from.x) / length;
  const uy = (to.y - from.y) / length;
  // Left-hand normal; the ring walks one side out and the other back.
  const nx = -uy;
  const ny = ux;

  const thickness = Math.max(2, length * 0.1);
  const headWidth = thickness * 3;
  const headLength = Math.min(length * 0.6, headWidth * 1.05);
  const bx = to.x - ux * headLength;
  const by = to.y - uy * headLength;

  const half = thickness / 2;
  const headHalf = headWidth / 2;
  return closedGeometry([
    { x: from.x + nx * half, y: from.y + ny * half },
    { x: bx + nx * half, y: by + ny * half },
    { x: bx + nx * headHalf, y: by + ny * headHalf },
    { x: to.x, y: to.y },
    { x: bx - nx * headHalf, y: by - ny * headHalf },
    { x: bx - nx * half, y: by - ny * half },
    { x: from.x - nx * half, y: from.y - ny * half },
  ]);
}

type ShapeNodeOptions = {
  fill?: string;
  stroke?: Stroke;
};

/**
 * PathNode positioned where the (artboard-local) geometry sits. Bounds
 * are clamped away from zero so degenerate vectors (a horizontal line)
 * still satisfy the positive-size schema.
 */
export function shapeNodeFromGeometry(
  shape: ShapeParams,
  geometry: PathGeometry,
  options: ShapeNodeOptions = {},
): PathNode | null {
  const bounds = pathGeometryBounds(geometry);
  if (!bounds) {
    return null;
  }

  const params = clampShapeParams(shape);
  const normalized = translatePathGeometry(geometry, -bounds.x, -bounds.y);
  const width = Math.max(bounds.width, 0.01);
  const height = Math.max(bounds.height, 0.01);

  return {
    id: createId("node"),
    type: "path",
    name: shapeDisplayName(params.kind),
    x: bounds.x,
    y: bounds.y,
    width,
    height,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    fill: { type: "solid", color: options.fill ?? "#111827" },
    ...(options.stroke ? { stroke: options.stroke } : {}),
    d: pathGeometryToSvg(normalized),
    intrinsicWidth: width,
    intrinsicHeight: height,
    geometry: normalized,
    shape: params,
  };
}

/** Box-shape node (triangle/polygon/star) filling the given bounds. */
export function createBoxShapeNode(
  shape: ShapeParams,
  bounds: Bounds,
  options: ShapeNodeOptions = {},
): PathNode | null {
  const width = Math.max(bounds.width, 1);
  const height = Math.max(bounds.height, 1);
  const geometry = shapeGeometryInBox(shape, width, height);
  if (!geometry) {
    return null;
  }
  const node = shapeNodeFromGeometry(shape, geometry, options);
  if (!node) {
    return null;
  }
  return { ...node, x: bounds.x, y: bounds.y };
}

/** Vector-shape node (line/arrow) spanning from→to; lines get a stroke. */
export function createVectorShapeNode(
  shape: ShapeParams,
  from: Vec2,
  to: Vec2,
  options: ShapeNodeOptions = {},
): PathNode | null {
  const geometry = shapeGeometryFromVector(shape, from, to);
  if (!geometry) {
    return null;
  }
  const stroke: Stroke | undefined =
    shape.kind === "line"
      ? (options.stroke ?? {
          color: options.fill ?? "#111827",
          width: 3,
          align: "center",
        })
      : options.stroke;
  return shapeNodeFromGeometry(shape, geometry, {
    ...options,
    ...(stroke ? { stroke } : {}),
  });
}

/**
 * Patch regenerating a shape node's geometry after a param edit, keeping
 * its position and size. Only box shapes have live params; returns null
 * for anything else (or a non-parametric path).
 */
export function shapeParamsPatch(
  node: PathNode,
  shape: ShapeParams,
): NodePatch | null {
  const params = clampShapeParams(shape);
  const geometry = shapeGeometryInBox(params, node.width, node.height);
  if (!geometry) {
    return null;
  }
  return {
    d: pathGeometryToSvg(geometry),
    geometry,
    intrinsicWidth: node.width,
    intrinsicHeight: node.height,
    shape: params,
  };
}
