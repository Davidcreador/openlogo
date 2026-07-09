import {
  type Bounds,
  type LogoNode,
  type Paint,
  type Vec2,
  angleFromPoints,
  defaultLinearGradient,
  isGradient,
  linearGradientPoints,
  rotatePoint,
} from "@openlogo/core";

/**
 * Geometry + drag math for the on-canvas gradient annotator (G tool).
 * All display points are artboard-local WITH the node's rotation
 * applied, matching what the renderer paints; drag math works in the
 * node's normalized, unrotated box space — the space gradient
 * coordinates live in.
 */

export type GradientHandlePart = "start" | "end" | "center" | "radius" | "focal";

export type GradientHandle = { part: GradientHandlePart } & Vec2;

function nodeBox(node: LogoNode): Bounds {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

/**
 * The box the renderer anchors this node's shaders to (intrinsic space
 * for paths — see SceneRenderer.paintBox). Fractions of this box equal
 * fractions of the artboard-space box, which is how display points map
 * back onto the canvas.
 */
function shaderBox(node: LogoNode): Bounds {
  return node.type === "path"
    ? { x: 0, y: 0, width: node.intrinsicWidth, height: node.intrinsicHeight }
    : nodeBox(node);
}

function nodeCenter(node: LogoNode): Vec2 {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

/** Fraction of the shader box → rotated artboard-local point. */
function fractionToLocal(node: LogoNode, fx: number, fy: number): Vec2 {
  const box = nodeBox(node);
  const point = { x: box.x + fx * box.width, y: box.y + fy * box.height };
  return node.rotation !== 0
    ? rotatePoint(point, nodeCenter(node), node.rotation)
    : point;
}

/** Rotated artboard-local point → fraction of the node box (0..1-ish). */
export function localToFraction(node: LogoNode, local: Vec2): Vec2 {
  const point =
    node.rotation !== 0
      ? rotatePoint(local, nodeCenter(node), -node.rotation)
      : local;
  return {
    x: (point.x - node.x) / node.width,
    y: (point.y - node.y) / node.height,
  };
}

/** Annotator handle positions for a node, artboard-local. */
export function gradientHandlePoints(node: LogoNode): GradientHandle[] {
  if (node.type === "group" || !isGradient(node.fill)) {
    return [];
  }
  const paint = node.fill;
  if (paint.type === "linear-gradient") {
    const box = shaderBox(node);
    const { start, end } = linearGradientPoints(paint, box);
    const frac = (p: Vec2) => ({
      x: (p.x - box.x) / box.width,
      y: (p.y - box.y) / box.height,
    });
    const s = frac(start);
    const e = frac(end);
    return [
      { part: "start", ...fractionToLocal(node, s.x, s.y) },
      { part: "end", ...fractionToLocal(node, e.x, e.y) },
    ];
  }
  const handles: GradientHandle[] = [
    { part: "center", ...fractionToLocal(node, paint.cx, paint.cy) },
    { part: "radius", ...fractionToLocal(node, paint.cx + paint.r, paint.cy) },
  ];
  if (paint.fx !== undefined && paint.fy !== undefined) {
    handles.push({ part: "focal", ...fractionToLocal(node, paint.fx, paint.fy) });
  }
  return handles;
}

/**
 * Materialize explicit normalized endpoints on a linear gradient so a
 * handle drag has both ends to work with (angle-only gradients derive
 * them from the shader box first).
 */
function withEndpoints(node: LogoNode, paint: Paint): Paint {
  if (paint.type !== "linear-gradient" || (paint.start && paint.end)) {
    return paint;
  }
  const box = shaderBox(node);
  const { start, end } = linearGradientPoints(paint, box);
  return {
    ...paint,
    start: {
      x: (start.x - box.x) / box.width,
      y: (start.y - box.y) / box.height,
    },
    end: { x: (end.x - box.x) / box.width, y: (end.y - box.y) / box.height },
  };
}

/** Display angle for normalized endpoints in this node's box. */
function displayAngle(node: LogoNode, start: Vec2, end: Vec2): number {
  return (
    Math.round(
      angleFromPoints(
        { x: start.x * node.width, y: start.y * node.height },
        { x: end.x * node.width, y: end.y * node.height },
      ) * 10,
    ) / 10
  );
}

/**
 * One annotator drag step: move `part` of `paint` to the normalized
 * point `frac` (node box space, unrotated). Returns the next paint.
 */
export function gradientDragPaint(
  node: LogoNode,
  paint: Paint,
  part: GradientHandlePart,
  frac: Vec2,
): Paint {
  const base = withEndpoints(node, paint);
  if (base.type === "linear-gradient") {
    const start = part === "start" ? frac : base.start!;
    const end = part === "end" ? frac : base.end!;
    return { ...base, start, end, angle: displayAngle(node, start, end) };
  }
  if (base.type !== "radial-gradient") {
    return base;
  }
  if (part === "center") {
    const dx = frac.x - base.cx;
    const dy = frac.y - base.cy;
    return {
      ...base,
      cx: frac.x,
      cy: frac.y,
      // The focal point rides along, Illustrator-style.
      ...(base.fx !== undefined ? { fx: base.fx + dx } : {}),
      ...(base.fy !== undefined ? { fy: base.fy + dy } : {}),
    };
  }
  if (part === "radius") {
    return {
      ...base,
      r: Math.max(0.02, Math.hypot(frac.x - base.cx, frac.y - base.cy)),
    };
  }
  // focal
  return { ...base, fx: frac.x, fy: frac.y };
}

/**
 * Drag on the node body (no handle): define the gradient line/spread
 * from the press point to the current point. A solid fill converts to a
 * two-stop linear gradient seeded from its colour; a radial keeps its
 * stops and recenters.
 */
export function gradientDefinePaint(
  node: LogoNode,
  fill: Paint,
  startFrac: Vec2,
  frac: Vec2,
): Paint {
  const paint = isGradient(fill) ? fill : defaultLinearGradient(fill.color);
  if (paint.type === "radial-gradient") {
    return {
      ...paint,
      cx: startFrac.x,
      cy: startFrac.y,
      r: Math.max(0.02, Math.hypot(frac.x - startFrac.x, frac.y - startFrac.y)),
    };
  }
  return {
    ...paint,
    start: startFrac,
    end: frac,
    angle: displayAngle(node, startFrac, frac),
  };
}
