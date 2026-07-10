import type { CanvasKit, Path } from "canvaskit-wasm";
import {
  pathCommandsToGeometry,
  pathGeometryToSvg,
  translatePathGeometry,
  type LogoNode,
  type PathFillRule,
  type PathGeometry,
} from "@openlogo/core";

export type BooleanOp = "union" | "subtract" | "intersect" | "exclude";

export type CombineResult = {
  /** Path data normalised to start at (0,0). */
  d: string;
  fillRule: PathFillRule;
  geometry: PathGeometry;
  x: number;
  y: number;
  width: number;
  height: number;
};

function fillRuleOf(ck: CanvasKit, path: Path): PathFillRule {
  return path.getFillType() === ck.FillType.EvenOdd ? "evenodd" : "nonzero";
}

function setFillRule(
  ck: CanvasKit,
  path: Path,
  fillRule: PathFillRule,
): void {
  path.setFillType(
    fillRule === "evenodd" ? ck.FillType.EvenOdd : ck.FillType.Winding,
  );
}

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
    setFillRule(ck, raw, node.fillRule);
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
 * Preserve each operand's filled area as editable geometry. Unlike a boolean
 * across operands, overlapping shapes remain independent even-odd contours.
 * Closed operands are simplified individually first so changing their global
 * rule cannot invent holes inside an operand; redundant internal contours may
 * therefore collapse.
 */
export function compoundNodes(
  ck: CanvasKit,
  nodes: readonly LogoNode[],
): CombineResult | null {
  if (nodes.length < 2) {
    return null;
  }

  const subpaths: PathGeometry["subpaths"] = [];
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const node of nodes) {
    const path = nodeToSkPath(ck, node);
    if (!path) {
      return null;
    }

    try {
      let geometry = pathCommandsToGeometry(path.toCmds());
      if (!geometry) {
        return null;
      }

      const hasClosed = geometry.subpaths.some((subpath) => subpath.closed);
      const hasOpen = geometry.subpaths.some((subpath) => !subpath.closed);
      if (hasClosed && hasOpen) {
        // One global even-odd rule cannot preserve both a complex filled area
        // and unrelated open strokable contours without splitting the node.
        return null;
      }
      if (hasClosed) {
        // Canonicalize each operand's filled AREA before concatenating it.
        // Otherwise switching a nonzero operand to the compound's even-odd
        // rule can invent holes inside that operand. CanvasKit mutates and
        // returns this same owned Path; it is still deleted once below.
        if (!path.simplify()) {
          return null;
        }
        setFillRule(ck, path, "evenodd");
        geometry = pathCommandsToGeometry(path.toCmds());
        if (!geometry) {
          return null;
        }
      }

      const bounds = path.computeTightBounds();
      const [nodeLeft, nodeTop, nodeRight, nodeBottom] = bounds;
      if (
        nodeLeft === undefined ||
        nodeTop === undefined ||
        nodeRight === undefined ||
        nodeBottom === undefined ||
        !Number.isFinite(nodeLeft) ||
        !Number.isFinite(nodeTop) ||
        !Number.isFinite(nodeRight) ||
        !Number.isFinite(nodeBottom) ||
        nodeRight < nodeLeft ||
        nodeBottom < nodeTop
      ) {
        return null;
      }

      subpaths.push(...geometry.subpaths);
      left = Math.min(left, nodeLeft);
      top = Math.min(top, nodeTop);
      right = Math.max(right, nodeRight);
      bottom = Math.max(bottom, nodeBottom);
    } finally {
      path.delete();
    }
  }

  if (subpaths.length === 0 || !Number.isFinite(left) || !Number.isFinite(top)) {
    return null;
  }

  const geometry = translatePathGeometry({ subpaths }, -left, -top);
  const width = Math.max(0.01, right - left);
  const height = Math.max(0.01, bottom - top);
  return {
    d: pathGeometryToSvg(geometry),
    fillRule: "evenodd",
    geometry,
    x: left,
    y: top,
    width,
    height,
  };
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
  const fillRule = fillRuleOf(ck, path);
  const geometry = pathCommandsToGeometry(path.toCmds());
  path.delete();
  if (!geometry) {
    return null;
  }

  return { d, fillRule, geometry, x: left, y: top, width, height };
}

/**
 * Offset path (Illustrator Object → Path → Offset Path): grow (amount>0)
 * or shrink (amount<0) a node's filled outline by |amount| px.
 *
 * Approach: stroke-expand a copy of the node's path at width 2·|amount| —
 * a ring straddling the outline by exactly |amount| on each side — then
 * PathOp it with the original fill region: union for outset, difference
 * for inset. Joins use Skia's Miter with limit 4 (Illustrator's default
 * miter join/limit); switching StrokeJoin to Round would produce
 * Illustrator's "round join" variant. Convex corners therefore stay
 * sharp until the miter limit trips, where Skia falls back to a bevel.
 *
 * Rotation is baked in by nodeToSkPath, so the result is an unrotated
 * path node in artboard-local space, normalised to its own origin.
 * Returns null when the inset swallows the shape entirely.
 */
export function offsetNodePath(
  ck: CanvasKit,
  node: LogoNode,
  amount: number,
): CombineResult | null {
  if (amount === 0) {
    return null;
  }

  const base = nodeToSkPath(ck, node);
  if (!base) {
    return null;
  }

  const ring = base.copy();
  const ok = ring.stroke({
    width: Math.abs(amount) * 2,
    join: ck.StrokeJoin.Miter,
    cap: ck.StrokeCap.Butt,
    miter_limit: 4,
    precision: 0.3,
  });
  if (!ok) {
    ring.delete();
    base.delete();
    return null;
  }

  const combined = ck.Path.MakeFromOp(
    base,
    ring,
    amount > 0 ? ck.PathOp.Union : ck.PathOp.Difference,
  );
  base.delete();
  ring.delete();
  if (!combined || combined.isEmpty()) {
    combined?.delete();
    return null;
  }

  const [left = 0, top = 0, right = 0, bottom = 0] =
    combined.computeTightBounds();
  const width = Math.max(0.01, right - left);
  const height = Math.max(0.01, bottom - top);
  combined.transform([1, 0, -left, 0, 1, -top, 0, 0, 1]);
  const d = combined.toSVGString();
  const fillRule = fillRuleOf(ck, combined);
  const geometry = pathCommandsToGeometry(combined.toCmds());
  combined.delete();
  if (!geometry) {
    return null;
  }

  return { d, fillRule, geometry, x: left, y: top, width, height };
}

export type RegionResult = {
  /** Path data in the same (artboard-local) space as the input nodes. */
  d: string;
  fillRule: PathFillRule;
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
      fillRule: fillRuleOf(ck, region),
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
  inputs: ReadonlyArray<{ d: string; fillRule: PathFillRule }>,
): CombineResult | null {
  let result: Path | null = null;
  for (const input of inputs) {
    const { d, fillRule } = input;
    const path = ck.Path.MakeFromSVGString(d);
    if (!path) {
      continue;
    }
    setFillRule(ck, path, fillRule);
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
  const fillRule = fillRuleOf(ck, result);
  const geometry = pathCommandsToGeometry(result.toCmds());
  result.delete();
  if (!geometry) {
    return null;
  }

  return { d, fillRule, geometry, x: left, y: top, width, height };
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
  const fillRule = fillRuleOf(ck, result);
  const geometry = pathCommandsToGeometry(result.toCmds());
  result.delete();
  if (!geometry) {
    return null;
  }

  return { d, fillRule, geometry, x: left, y: top, width, height };
}
