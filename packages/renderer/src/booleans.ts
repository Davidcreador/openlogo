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
 * Convert a node's stroke into a filled outline path (Illustrator's
 * "Outline Stroke"). Returns the outline normalised to its own origin.
 */
export function expandStroke(
  ck: CanvasKit,
  node: LogoNode,
): CombineResult | null {
  if (!node.stroke || node.stroke.width <= 0) {
    return null;
  }

  const path = nodeToSkPath(ck, node);
  if (!path) {
    return null;
  }

  const ok = path.stroke({
    width: node.stroke.width,
    join: ck.StrokeJoin.Miter,
    cap: ck.StrokeCap.Butt,
    miter_limit: 4,
    precision: 0.3,
  });

  if (!ok) {
    path.delete();
    return null;
  }

  const bounds = path.computeTightBounds();
  const [left = 0, top = 0, right = 0, bottom = 0] = bounds;
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  path.transform([1, 0, -left, 0, 1, -top, 0, 0, 1]);
  const d = path.toSVGString();
  path.delete();

  return { d, x: left, y: top, width, height };
}

export type RegionResult = {
  /** Path data in the same (artboard-local) space as the input nodes. */
  d: string;
  bounds: { x: number; y: number; width: number; height: number };
  /** Indices into the input nodes that cover this region, back-to-front. */
  sources: number[];
};

const REGION_MIN_SIZE = 0.05;

/**
 * Planar decomposition of the nodes' filled areas into atomic regions
 * (Illustrator Shape Builder): for every non-empty subset S of nodes,
 * the region is (∩ S) − (∪ others). Exponential in operand count —
 * callers cap it (see the editor's SHAPE_BUILDER_MAX_NODES).
 */
export function computeRegions(
  ck: CanvasKit,
  nodes: LogoNode[],
): RegionResult[] {
  const entries = nodes
    .map((node, index) => ({ index, path: nodeToSkPath(ck, node) }))
    .filter(
      (entry): entry is { index: number; path: Path } => entry.path !== null,
    );

  const regions: RegionResult[] = [];

  for (let mask = 1; mask < 1 << entries.length; mask += 1) {
    let region: Path | null = null;
    let failed = false;

    // Intersect the included operands…
    for (const [i, entry] of entries.entries()) {
      if ((mask & (1 << i)) === 0) {
        continue;
      }
      if (!region) {
        region = entry.path.copy();
        continue;
      }
      const next = ck.Path.MakeFromOp(region, entry.path, ck.PathOp.Intersect);
      region.delete();
      if (!next) {
        failed = true;
        break;
      }
      region = next;
    }
    if (failed || !region) {
      continue;
    }
    if (region.isEmpty()) {
      region.delete();
      continue;
    }

    // …then subtract the excluded ones.
    for (const [i, entry] of entries.entries()) {
      if ((mask & (1 << i)) !== 0) {
        continue;
      }
      const next = ck.Path.MakeFromOp(region, entry.path, ck.PathOp.Difference);
      region.delete();
      if (!next) {
        failed = true;
        break;
      }
      region = next;
    }
    if (failed) {
      continue;
    }
    if (region.isEmpty()) {
      region.delete();
      continue;
    }

    const [left = 0, top = 0, right = 0, bottom = 0] =
      region.computeTightBounds();
    const width = right - left;
    const height = bottom - top;
    if (width < REGION_MIN_SIZE || height < REGION_MIN_SIZE) {
      region.delete();
      continue;
    }

    regions.push({
      d: region.toSVGString(),
      bounds: { x: left, y: top, width, height },
      sources: entries
        .filter((_, i) => (mask & (1 << i)) !== 0)
        .map((entry) => entry.index),
    });
    region.delete();
  }

  for (const entry of entries) {
    entry.path.delete();
  }
  return regions;
}

/**
 * Union artboard-local path data strings into one node-ready path,
 * normalised to start at (0,0) — same contract as combineNodes.
 */
export function unionPathData(
  ck: CanvasKit,
  ds: readonly string[],
): CombineResult | null {
  let result: Path | null = null;
  for (const d of ds) {
    const path = ck.Path.MakeFromSVGString(d);
    if (!path) {
      continue;
    }
    if (!result) {
      result = path;
      continue;
    }
    const combined = ck.Path.MakeFromOp(result, path, ck.PathOp.Union);
    result.delete();
    path.delete();
    if (!combined) {
      return null;
    }
    result = combined;
  }
  if (!result || result.isEmpty()) {
    result?.delete();
    return null;
  }

  const [left = 0, top = 0, right = 0, bottom = 0] =
    result.computeTightBounds();
  const width = Math.max(0.01, right - left);
  const height = Math.max(0.01, bottom - top);
  result.transform([1, 0, -left, 0, 1, -top, 0, 0, 1]);
  const d = result.toSVGString();
  result.delete();

  return { d, x: left, y: top, width, height };
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
      for (let j = i + 1; j < paths.length; j += 1) {
        paths[j]!.delete();
      }
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
