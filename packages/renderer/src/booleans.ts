import type { CanvasKit, Path } from "canvaskit-wasm";
import type { LogoNode } from "@openlogo/core";

export type BooleanOp = "union" | "subtract" | "intersect" | "exclude";

export type CombineResult = {
  /** Path data normalised to start at (0,0). */
  d: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Build a Skia path for a node in artboard-local coordinates,
 * rotation baked in. Text nodes are not supported (need glyph outlines).
 */
export function nodeToSkPath(ck: CanvasKit, node: LogoNode): Path | null {
  let path: Path | null = null;

  if (node.type === "rectangle") {
    path = new ck.Path();
    path.addRRect(
      ck.RRectXY(
        ck.XYWHRect(node.x, node.y, node.width, node.height),
        node.cornerRadius,
        node.cornerRadius,
      ),
    );
  } else if (node.type === "ellipse") {
    path = new ck.Path();
    path.addOval(ck.XYWHRect(node.x, node.y, node.width, node.height));
  } else if (node.type === "path") {
    const raw = ck.Path.MakeFromSVGString(node.d);
    if (!raw) {
      return null;
    }
    // intrinsic space → node box.
    raw.transform([
      node.width / node.intrinsicWidth,
      0,
      node.x,
      0,
      node.height / node.intrinsicHeight,
      node.y,
      0,
      0,
      1,
    ]);
    path = raw;
  } else {
    return null;
  }

  if (node.rotation !== 0) {
    const radians = (node.rotation * Math.PI) / 180;
    path.transform(
      ck.Matrix.rotated(
        radians,
        node.x + node.width / 2,
        node.y + node.height / 2,
      ),
    );
  }

  return path;
}

/**
 * Combine nodes with a Skia PathOp. Nodes must be in z-order
 * (back to front); `subtract` removes every later node from the first
 * ("minus front"). Returns null when fewer than two nodes are combinable.
 */
export function combineNodes(
  ck: CanvasKit,
  nodes: LogoNode[],
  op: BooleanOp,
): CombineResult | null {
  const paths = nodes
    .map((node) => nodeToSkPath(ck, node))
    .filter((path): path is Path => path !== null);

  if (paths.length < 2) {
    for (const path of paths) {
      path.delete();
    }
    return null;
  }

  const skOp = {
    union: ck.PathOp.Union,
    subtract: ck.PathOp.Difference,
    intersect: ck.PathOp.Intersect,
    exclude: ck.PathOp.XOR,
  }[op];

  let result = paths[0]!;
  for (let i = 1; i < paths.length; i += 1) {
    const combined = ck.Path.MakeFromOp(result, paths[i]!, skOp);
    result.delete();
    paths[i]!.delete();
    if (!combined) {
      return null;
    }
    result = combined;
  }

  const bounds = result.computeTightBounds();
  const [left = 0, top = 0, right = 0, bottom = 0] = bounds;
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);

  // Normalise so the path's own coordinates start at the origin.
  result.transform([1, 0, -left, 0, 1, -top, 0, 0, 1]);
  const d = result.toSVGString();
  result.delete();

  return { d, x: left, y: top, width, height };
}
