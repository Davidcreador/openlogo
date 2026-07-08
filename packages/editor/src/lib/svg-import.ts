import type { CanvasKit } from "canvaskit-wasm";
import {
  type LogoNode,
  type PathNode,
  createId,
  getActiveArtboard,
} from "@openlogo/core";
import { getCanvasKit } from "./canvaskit";
import { documentStore } from "../state/document";

/**
 * SVG import, v1: every supported shape is flattened to a path with its
 * cumulative transform baked in, imported as one group centred on the
 * artboard. Covers exported logo SVGs (rect/circle/ellipse/path/polygon/
 * polyline/line + nested <g> transforms). Skipped: text (outline it in
 * the source tool), gradients/patterns (fill falls back to first colour
 * guess or black), clip paths, masks.
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
  d: string;
  matrix: Mat;
  fill: string;
  opacity: number;
  stroke: { color: string; width: number } | null;
};

function walk(
  element: Element,
  matrix: Mat,
  inherited: { fill: string; opacity: number },
  output: FlatShape[],
): void {
  const localMatrix = multiply(
    matrix,
    parseTransform(element.getAttribute("transform")),
  );
  const fillRaw = styleValue(element, "fill");
  const fill = fillRaw ?? inherited.fill;
  const opacity =
    inherited.opacity * Number(styleValue(element, "opacity") ?? 1);

  const tag = element.tagName.toLowerCase();
  if (tag === "g" || tag === "svg") {
    for (const child of Array.from(element.children)) {
      walk(child, localMatrix, { fill, opacity }, output);
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

  output.push({
    d,
    matrix: localMatrix,
    fill: resolvedFill,
    opacity,
    stroke:
      strokeColor && strokeColor !== "none"
        ? { color: strokeColor, width: strokeWidth }
        : null,
  });
}

function buildNode(
  ck: CanvasKit,
  shape: FlatShape,
  groupId: string,
  index: number,
): PathNode | null {
  const path = ck.Path.MakeFromSVGString(shape.d);
  if (!path) {
    return null;
  }

  const [a, b, c, d2, e, f] = shape.matrix;
  path.transform([a, c, e, b, d2, f, 0, 0, 1]);

  const bounds = path.computeTightBounds();
  const [left = 0, top = 0, right = 0, bottom = 0] = bounds;
  const width = Math.max(0.5, right - left);
  const height = Math.max(0.5, bottom - top);
  path.transform([1, 0, -left, 0, 1, -top, 0, 0, 1]);
  const normalized = path.toSVGString();
  path.delete();

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
    intrinsicWidth: width,
    intrinsicHeight: height,
    groupId,
  };
}

/** Import an SVG string as a group of path nodes. Returns new node ids. */
export async function importSvg(svgText: string): Promise<string[]> {
  const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = parsed.querySelector("svg");
  if (!root || parsed.querySelector("parsererror")) {
    return [];
  }

  const shapes: FlatShape[] = [];
  walk(root, IDENTITY, { fill: "#000000", opacity: 1 }, shapes);
  if (shapes.length === 0) {
    return [];
  }

  const ck = await getCanvasKit();
  const groupId = createId("group");
  const nodes = shapes
    .map((shape, index) => buildNode(ck, shape, groupId, index))
    .filter((node): node is PathNode => node !== null);
  if (nodes.length === 0) {
    return [];
  }

  // Fit and centre on the artboard.
  const artboard = getActiveArtboard(documentStore.document);
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.width));
  const maxY = Math.max(...nodes.map((n) => n.y + n.height));
  const spanW = maxX - minX;
  const spanH = maxY - minY;
  const scale = Math.min(
    1,
    (artboard.width * 0.8) / spanW,
    (artboard.height * 0.8) / spanH,
  );
  const offsetX = (artboard.width - spanW * scale) / 2 - minX * scale;
  const offsetY = (artboard.height - spanH * scale) / 2 - minY * scale;

  const placed: LogoNode[] = nodes.map((node) => ({
    ...node,
    x: node.x * scale + offsetX,
    y: node.y * scale + offsetY,
    width: node.width * scale,
    height: node.height * scale,
    // Path data stays in intrinsic space; only the box scales.
  }));

  documentStore.apply({
    type: "insert-nodes",
    artboardId: artboard.id,
    nodes: placed,
  });

  return placed.map((node) => node.id);
}
