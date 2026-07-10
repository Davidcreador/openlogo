import { Effect } from "effect";
import type { CanvasKit } from "canvaskit-wasm";
import {
  type GroupNode,
  type LogoNode,
  type PathFillRule,
  type PathNode,
  createGroup,
  createId,
  getActiveArtboard,
  pathCommandsToGeometry,
} from "@openlogo/core";
import { type CanvasKitLoadError, canvasKit } from "./canvaskit";
import { documentStore } from "../state/document";

/**
 * SVG import, v1: every supported shape is flattened to a path with its
 * cumulative transform baked in, imported as one group centred on the
 * artboard. Covers exported logo SVGs (rect/circle/ellipse/path/polygon/
 * polyline/line + nested <g> transforms). Simple user-space clipPath groups
 * round-trip as editable clipping groups. Skipped: text (outline it in the
 * source tool), gradients/patterns (fill falls back to black), SVG masks,
 * objectBoundingBox clips, and clip paths made from multiple elements.
 */

type Mat = [number, number, number, number, number, number]; // a b c d e f

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function multiply(m1: Mat, m2: Mat): Mat {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** Parse an SVG `transform` attribute (translate/scale/rotate/matrix). */
function parseTransform(value: string | null): Mat {
  if (!value) {
    return IDENTITY;
  }

  let matrix = IDENTITY;
  const pattern = /(translate|scale|rotate|matrix)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const args = match[2]!
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = args;

    switch (match[1]) {
      case "translate":
        matrix = multiply(matrix, [1, 0, 0, 1, a, args.length > 1 ? b : 0]);
        break;
      case "scale":
        matrix = multiply(matrix, [a, 0, 0, args.length > 1 ? b : a, 0, 0]);
        break;
      case "rotate": {
        const rad = (a * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        let rot: Mat = [cos, sin, -sin, cos, 0, 0];
        if (args.length >= 3) {
          rot = multiply(
            multiply([1, 0, 0, 1, b, c], rot),
            [1, 0, 0, 1, -b, -c],
          );
        }
        matrix = multiply(matrix, rot);
        break;
      }
      case "matrix":
        if (args.length === 6) {
          matrix = multiply(matrix, [a, b, c, d, e, f]);
        }
        break;
    }
  }

  return matrix;
}

function styleValue(element: Element, name: string): string | null {
  const style = element.getAttribute("style");
  if (style) {
    const found = style
      .split(";")
      .map((part) => part.split(":"))
      .find(([key]) => key?.trim() === name);
    if (found?.[1]) {
      return found[1].trim();
    }
  }
  return element.getAttribute(name);
}

/** Convert a shape element to raw SVG path data in its own coordinates. */
function shapeToPathData(element: Element): string | null {
  const num = (name: string, fallback = 0) =>
    Number(element.getAttribute(name) ?? fallback);

  switch (element.tagName.toLowerCase()) {
    case "path":
      return element.getAttribute("d");
    case "rect": {
      const x = num("x");
      const y = num("y");
      const w = num("width");
      const h = num("height");
      const rx = Math.min(num("rx"), w / 2);
      if (w <= 0 || h <= 0) {
        return null;
      }
      if (rx <= 0) {
        return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
      }
      return [
        `M ${x + rx} ${y}`,
        `H ${x + w - rx}`,
        `A ${rx} ${rx} 0 0 1 ${x + w} ${y + rx}`,
        `V ${y + h - rx}`,
        `A ${rx} ${rx} 0 0 1 ${x + w - rx} ${y + h}`,
        `H ${x + rx}`,
        `A ${rx} ${rx} 0 0 1 ${x} ${y + h - rx}`,
        `V ${y + rx}`,
        `A ${rx} ${rx} 0 0 1 ${x + rx} ${y}`,
        "Z",
      ].join(" ");
    }
    case "circle":
    case "ellipse": {
      const cx = num("cx");
      const cy = num("cy");
      const rx =
        element.tagName.toLowerCase() === "circle" ? num("r") : num("rx");
      const ry =
        element.tagName.toLowerCase() === "circle" ? num("r") : num("ry");
      if (rx <= 0 || ry <= 0) {
        return null;
      }
      return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
    }
    case "polygon":
    case "polyline": {
      const points = (element.getAttribute("points") ?? "")
        .trim()
        .split(/[\s,]+/)
        .map(Number);
      if (points.length < 4) {
        return null;
      }
      const parts = [`M ${points[0]} ${points[1]}`];
      for (let i = 2; i < points.length - 1; i += 2) {
        parts.push(`L ${points[i]} ${points[i + 1]}`);
      }
      if (element.tagName.toLowerCase() === "polygon") {
        parts.push("Z");
      }
      return parts.join(" ");
    }
    case "line":
      return `M ${num("x1")} ${num("y1")} L ${num("x2")} ${num("y2")}`;
    default:
      return null;
  }
}

type FlatShape = {
  id: string;
  d: string;
  matrix: Mat;
  fill: string;
  fillRule: PathFillRule;
  opacity: number;
  stroke: { color: string; width: number } | null;
  ownerClipId: string | null;
  order: number;
};

type FlatClipGroup = {
  id: string;
  parentClipId: string | null;
  mask: FlatShape;
  order: number;
};

type WalkState = {
  root: Element;
  shapes: FlatShape[];
  clips: FlatClipGroup[];
  nextId: number;
  nextOrder: number;
};

function nextFlatId(state: WalkState, prefix: string): string {
  state.nextId += 1;
  return `${prefix}-${state.nextId}`;
}

function clipReferenceId(value: string | null): string | null {
  const match = value?.match(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/i);
  return match?.[1] ?? null;
}

/** Capture the conservative clipPath subset emitted by OpenLogo itself. */
function captureClipGroup(
  element: Element,
  matrix: Mat,
  parentClipId: string | null,
  state: WalkState,
): string | null {
  const referenceId = clipReferenceId(styleValue(element, "clip-path"));
  if (!referenceId) {
    return null;
  }
  const definition = Array.from(state.root.querySelectorAll("clipPath")).find(
    (candidate) => candidate.getAttribute("id") === referenceId,
  );
  if (
    !definition ||
    (definition.getAttribute("clipPathUnits") ?? "userSpaceOnUse") !==
      "userSpaceOnUse"
  ) {
    return null;
  }

  const maskElements = Array.from(definition.children).filter((child) =>
    Boolean(shapeToPathData(child)),
  );
  if (maskElements.length !== 1) {
    return null;
  }
  const maskElement = maskElements[0]!;
  const d = shapeToPathData(maskElement);
  if (!d) {
    return null;
  }
  const rule = (
    styleValue(maskElement, "clip-rule") ??
    styleValue(maskElement, "fill-rule") ??
    styleValue(definition, "clip-rule") ??
    "nonzero"
  )
    .trim()
    .toLowerCase();
  const fillRule: PathFillRule = rule === "evenodd" ? "evenodd" : "nonzero";
  const order = state.nextOrder++;
  const id = nextFlatId(state, "clip");
  const definitionMatrix = multiply(
    matrix,
    parseTransform(definition.getAttribute("transform")),
  );
  const mask: FlatShape = {
    id: nextFlatId(state, "mask"),
    d,
    matrix: multiply(
      definitionMatrix,
      parseTransform(maskElement.getAttribute("transform")),
    ),
    fill: "#000000",
    fillRule,
    opacity: 1,
    stroke: null,
    ownerClipId: id,
    order,
  };
  state.clips.push({ id, parentClipId, mask, order });
  return id;
}

function walk(
  element: Element,
  matrix: Mat,
  inherited: { fill: string; fillRule: PathFillRule; opacity: number },
  ownerClipId: string | null,
  state: WalkState,
): void {
  const localMatrix = multiply(
    matrix,
    parseTransform(element.getAttribute("transform")),
  );
  const fillRaw = styleValue(element, "fill");
  const fill = fillRaw ?? inherited.fill;
  const fillRuleRaw = styleValue(element, "fill-rule")?.trim().toLowerCase();
  const fillRule =
    fillRuleRaw === "initial"
      ? "nonzero"
      : fillRuleRaw === "evenodd" || fillRuleRaw === "nonzero"
        ? fillRuleRaw
        : inherited.fillRule;
  const opacity =
    inherited.opacity * Number(styleValue(element, "opacity") ?? 1);

  const tag = element.tagName.toLowerCase();
  if (tag === "g" || tag === "svg") {
    const nextOwner =
      tag === "g"
        ? (captureClipGroup(element, localMatrix, ownerClipId, state) ??
          ownerClipId)
        : ownerClipId;
    for (const child of Array.from(element.children)) {
      walk(
        child,
        localMatrix,
        { fill, fillRule, opacity },
        nextOwner,
        state,
      );
    }
    return;
  }
  if (tag === "defs" || tag === "clippath" || tag === "mask" || tag === "text") {
    return;
  }

  const d = shapeToPathData(element);
  if (!d) {
    return;
  }

  const strokeColor = styleValue(element, "stroke");
  const strokeWidth = Number(styleValue(element, "stroke-width") ?? 1);
  const resolvedFill =
    !fill || fill === "none"
      ? "#00000000"
      : fill.startsWith("url(")
        ? "#111827" // gradients/patterns unsupported; fall back
        : fill;

  if (resolvedFill === "#00000000" && (!strokeColor || strokeColor === "none")) {
    return;
  }

  state.shapes.push({
    id: nextFlatId(state, "shape"),
    d,
    matrix: localMatrix,
    fill: resolvedFill,
    fillRule,
    opacity,
    ownerClipId,
    order: state.nextOrder++,
    stroke:
      strokeColor && strokeColor !== "none"
        ? { color: strokeColor, width: strokeWidth }
        : null,
  });
}

/**
 * The Skia path is an acquired WASM resource: it is deleted on every exit,
 * including a throw mid-transform (which previously leaked it).
 */
function buildNode(
  ck: CanvasKit,
  shape: FlatShape,
  index: number,
): Effect.Effect<PathNode | null> {
  return Effect.acquireUseRelease(
    Effect.sync(() => ck.Path.MakeFromSVGString(shape.d)),
    (path) => Effect.sync(() => (path ? nodeFromPath(path, shape, index) : null)),
    (path) => Effect.sync(() => path?.delete()),
  );
}

type SkiaPath = NonNullable<ReturnType<CanvasKit["Path"]["MakeFromSVGString"]>>;

function nodeFromPath(
  path: SkiaPath,
  shape: FlatShape,
  index: number,
): PathNode | null {
  const [a, b, c, d2, e, f] = shape.matrix;
  path.transform([a, c, e, b, d2, f, 0, 0, 1]);

  const bounds = path.computeTightBounds();
  const [left = 0, top = 0, right = 0, bottom = 0] = bounds;
  const width = Math.max(0.5, right - left);
  const height = Math.max(0.5, bottom - top);
  path.transform([1, 0, -left, 0, 1, -top, 0, 0, 1]);
  const normalized = path.toSVGString();
  const geometry = pathCommandsToGeometry(path.toCmds());
  if (!geometry) {
    return null;
  }

  return {
    id: createId("node"),
    type: "path",
    name: `Imported ${index + 1}`,
    x: left,
    y: top,
    width,
    height,
    rotation: 0,
    opacity: Math.max(0.01, Math.min(1, shape.opacity)),
    visible: true,
    locked: false,
    fill: { type: "solid", color: shape.fill },
    fillRule: shape.fillRule,
    ...(shape.stroke
      ? {
          stroke: {
            color: shape.stroke.color,
            width: shape.stroke.width,
            align: "center" as const,
          },
        }
      : {}),
    d: normalized,
    geometry,
    intrinsicWidth: width,
    intrinsicHeight: height,
  };
}

/**
 * Import an SVG string as one group of path nodes. Succeeds with [groupId]
 * ([] when nothing importable); unparseable input is an empty result, not
 * an error — only a CanvasKit load failure lands in the error channel.
 */
export const importSvg = (
  svgText: string,
): Effect.Effect<string[], CanvasKitLoadError> =>
  Effect.gen(function* () {
    const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const root = parsed.querySelector("svg");
    if (!root || parsed.querySelector("parsererror")) {
      return [];
    }

    const state: WalkState = {
      root,
      shapes: [],
      clips: [],
      nextId: 0,
      nextOrder: 0,
    };
    walk(
      root,
      IDENTITY,
      { fill: "#000000", fillRule: "nonzero", opacity: 1 },
      null,
      state,
    );
    if (state.shapes.length === 0) {
      return [];
    }

    const ck = yield* canvasKit;
    const flatShapes = [
      ...state.shapes,
      ...state.clips.map((clip) => clip.mask),
    ];
    const built = (yield* Effect.all(
      flatShapes.map((shape, index) =>
        buildNode(ck, shape, index).pipe(
          Effect.map((node) => (node ? { shape, node } : null)),
        ),
      ),
    )).filter(
      (item): item is { shape: FlatShape; node: PathNode } => item !== null,
    );
    if (built.length === 0) {
      return [];
    }

    // Fit and centre on the artboard.
    const artboard = getActiveArtboard(documentStore.document);
    const minX = Math.min(...built.map(({ node }) => node.x));
    const minY = Math.min(...built.map(({ node }) => node.y));
    const maxX = Math.max(...built.map(({ node }) => node.x + node.width));
    const maxY = Math.max(...built.map(({ node }) => node.y + node.height));
    const spanW = maxX - minX;
    const spanH = maxY - minY;
    const scale = Math.min(
      1,
      (artboard.width * 0.8) / spanW,
      (artboard.height * 0.8) / spanH,
    );
    const offsetX = (artboard.width - spanW * scale) / 2 - minX * scale;
    const offsetY = (artboard.height - spanH * scale) / 2 - minY * scale;

    const placed = built.map(({ shape, node }) => ({
      shape,
      node: {
        ...node,
        x: node.x * scale + offsetX,
        y: node.y * scale + offsetY,
        width: node.width * scale,
        height: node.height * scale,
        // Path data stays in intrinsic space; only the box scales.
      } as PathNode,
    }));
    const placedByFlatId = new Map(
      placed.map((item) => [item.shape.id, item.node] as const),
    );

    type OrderedNode = { id: string; order: number };
    const groupsByClipId = new Map<string, OrderedNode>();
    const groups: GroupNode[] = [];

    // Clip instances are recorded outer-to-inner; build inner groups first so
    // each parent can own a child clipping group without flattening it.
    for (const clip of [...state.clips].reverse()) {
      const content: OrderedNode[] = [
        ...state.shapes
          .filter((shape) => shape.ownerClipId === clip.id)
          .map((shape) => ({
            id: placedByFlatId.get(shape.id)?.id ?? "",
            order: shape.order,
          })),
        ...state.clips
          .filter((child) => child.parentClipId === clip.id)
          .map((child) => groupsByClipId.get(child.id))
          .filter((item): item is OrderedNode => item !== undefined),
      ]
        .filter((item) => item.id !== "")
        .sort((a, b) => a.order - b.order);
      if (content.length === 0) {
        continue;
      }

      const mask = placedByFlatId.get(clip.mask.id);
      const children = content.map((item) => item.id);
      if (mask) {
        mask.name = "Clipping path";
        children.push(mask.id);
      }
      const group = createGroup(children);
      group.name = mask ? "Clipping group" : "Imported SVG group";
      if (mask) {
        group.clippingMaskId = mask.id;
      }
      groups.push(group);
      groupsByClipId.set(clip.id, { id: group.id, order: clip.order });
    }

    const roots: OrderedNode[] = [
      ...state.shapes
        .filter((shape) => shape.ownerClipId === null)
        .map((shape) => ({
          id: placedByFlatId.get(shape.id)?.id ?? "",
          order: shape.order,
        })),
      ...state.clips
        .filter((clip) => clip.parentClipId === null)
        .map((clip) => groupsByClipId.get(clip.id))
        .filter((item): item is OrderedNode => item !== undefined),
    ]
      .filter((item) => item.id !== "")
      .sort((a, b) => a.order - b.order);
    if (roots.length === 0) {
      return [];
    }

    let rootIds = roots.map((item) => item.id);
    if (rootIds.length > 1) {
      const imported = createGroup(rootIds);
      imported.name = "Imported SVG";
      groups.push(imported);
      rootIds = [imported.id];
    }

    const nodeTable = new Map<string, LogoNode>([
      ...placed.map(({ node }) => [node.id, node] as const),
      ...groups.map((group) => [group.id, group] as const),
    ]);
    const reachable = new Set<string>();
    const visit = (id: string) => {
      if (reachable.has(id)) {
        return;
      }
      const node = nodeTable.get(id);
      if (!node) {
        return;
      }
      reachable.add(id);
      if (node.type === "group") {
        node.children.forEach(visit);
      }
    };
    rootIds.forEach(visit);

    documentStore.apply({
      type: "insert-nodes",
      artboardId: artboard.id,
      nodes: [...nodeTable.values()].filter((node) => reachable.has(node.id)),
    });
    return rootIds;
  });
