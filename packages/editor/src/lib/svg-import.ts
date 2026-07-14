import { Data, Effect } from "effect";
import type { CanvasKit } from "canvaskit-wasm";
import {
  type BlendMode,
  type Effect as LogoEffect,
  type GradientStop,
  type GroupNode,
  type LogoNode,
  type Paint,
  type PathFillRule,
  type PathNode,
  type RectangleNode,
  type Stroke,
  type TextNode,
  createEllipse,
  createGroup,
  createId,
  createRectangle,
  createText,
  getActiveArtboard,
  normalizeTextPathContent,
  pathCommandsToGeometry,
} from "@openlogo/core";
import { type CanvasKitLoadError, canvasKit } from "./canvaskit";
import { documentStore } from "../state/document";

/**
 * SVG import: foreign shapes are flattened to paths with their
 * cumulative transform baked in, imported as one group centred on the
 * artboard. Covers exported logo SVGs (rect/circle/ellipse/path/polygon/
 * polyline/line + nested <g> transforms). Simple user-space clipPath groups
 * round-trip as editable clipping groups. OpenLogo metadata restores leaf
 * types and editor-only fields. Unsupported paint/filter/text subsets are
 * imported conservatively and returned as warnings instead of disappearing.
 */

export type SvgTransformMatrix = [
  number,
  number,
  number,
  number,
  number,
  number,
]; // a b c d e f
type Mat = SvgTransformMatrix;

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
export const MAX_SVG_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_SVG_IMPORT_ELEMENTS = 2_000;
export const MAX_SVG_IMPORT_PATH_CHARS = 1_000_000;
const MAX_SVG_IMPORT_DEPTH = 128;

export class SvgImportError extends Data.TaggedError("SvgImportError")<{
  readonly reason: string;
}> {}

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
    if (args.length === 0 || args.some((value) => !Number.isFinite(value))) {
      continue;
    }
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
    const found = style.split(";").find((part) => {
      const colon = part.indexOf(":");
      return colon >= 0 && part.slice(0, colon).trim() === name;
    });
    if (found) {
      return found.slice(found.indexOf(":") + 1).trim();
    }
  }
  return element.getAttribute(name);
}

function numericAttr(
  element: Element,
  name: string,
  fallback: number,
): number {
  const raw = element.getAttribute(name);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function paintReferenceId(value: string | null): string | null {
  const match = value?.match(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/i);
  return match?.[1] ?? null;
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
  fill: Paint;
  fillRule: PathFillRule;
  opacity: number;
  stroke: Stroke | null;
  name: string;
  visible: boolean;
  blendMode?: BlendMode;
  effects?: LogoEffect[];
  sourceId?: string;
  nodeType?: "path" | "rectangle" | "ellipse";
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  intrinsicWidth?: number;
  intrinsicHeight?: number;
  cornerRadius?: number;
  ownerClipId: string | null;
  order: number;
};

type FlatText = {
  id: string;
  node: TextNode;
  sourceId?: string;
  pathSourceId?: string;
  pathDefinitionId?: string;
  pathFlatId?: string;
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
  clipDefinitions: ReadonlyMap<string, Element>;
  paintDefinitions: ReadonlyMap<string, Element>;
  filterDefinitions: ReadonlyMap<string, Element>;
  pathDefinitions: ReadonlyMap<string, Element>;
  shapes: FlatShape[];
  texts: FlatText[];
  clips: FlatClipGroup[];
  warnings: Map<string, number>;
  openLogo: boolean;
  nextId: number;
  nextOrder: number;
  pathChars: number;
  limitExceeded: boolean;
};

type Presentation = {
  fill: string;
  stroke: string | null;
  strokeWidth: number;
  fillRule: PathFillRule;
  opacity: number;
  visible: boolean;
  blendMode?: BlendMode;
  filterId?: string;
};

const BLEND_MODES = new Set<BlendMode>([
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
]);

function warn(state: WalkState, kind: string): void {
  state.warnings.set(kind, (state.warnings.get(kind) ?? 0) + 1);
}

function warningMessages(warnings: ReadonlyMap<string, number>): string[] {
  const labels: Record<string, readonly [string, string]> = {
    text: ["unsupported text element", "unsupported text elements"],
    paint: ["unsupported paint server", "unsupported paint servers"],
    filter: ["unsupported filter", "unsupported filters"],
    group: ["group hierarchy", "group hierarchies"],
  };
  return [...warnings.entries()].map(([kind, count]) => {
    const label = labels[kind];
    return `${count} ${label ? label[count === 1 ? 0 : 1] : kind} could not be imported faithfully.`;
  });
}

export type SvgImportResult = string[] & { warnings: readonly string[] };

function importResult(
  ids: string[],
  warnings: ReadonlyMap<string, number>,
): SvgImportResult {
  return Object.assign(ids, { warnings: warningMessages(warnings) });
}

function normalizedOffset(value: string | null): number {
  if (!value) {
    return 0;
  }
  const percent = value.trim().endsWith("%");
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed)
    ? Math.min(1, Math.max(0, percent ? parsed / 100 : parsed))
    : 0;
}

function normalizedGradientAttr(
  element: Element,
  name: string,
  fallback: number,
): number {
  const raw = element.getAttribute(name);
  if (raw === null) {
    return fallback;
  }
  const value = Number.parseFloat(raw);
  return Number.isFinite(value)
    ? raw.trim().endsWith("%")
      ? value / 100
      : value
    : fallback;
}

function gradientStops(element: Element): GradientStop[] {
  return Array.from(element.children)
    .filter((child) => child.tagName.toLowerCase() === "stop")
    .map((stop) => {
      const alpha = Number(styleValue(stop, "stop-opacity") ?? 1);
      return {
        offset: normalizedOffset(stop.getAttribute("offset")),
        color: styleValue(stop, "stop-color") ?? "#000000",
        ...(Number.isFinite(alpha) && alpha < 1
          ? { alpha: Math.min(1, Math.max(0, alpha)) }
          : {}),
      };
    });
}

function paintFromValue(value: string | null, state: WalkState): Paint {
  if (!value || value.trim().toLowerCase() === "none") {
    return { type: "solid", color: "#00000000" };
  }
  const id = paintReferenceId(value);
  if (!id) {
    return { type: "solid", color: value };
  }
  const definition = state.paintDefinitions.get(id);
  if (!definition) {
    warn(state, "paint");
    return { type: "solid", color: "#111827" };
  }
  const units = definition.getAttribute("gradientUnits") ?? "objectBoundingBox";
  if (
    units !== "objectBoundingBox" ||
    definition.hasAttribute("gradientTransform") ||
    definition.hasAttribute("href") ||
    definition.hasAttribute("xlink:href")
  ) {
    warn(state, "paint");
    return { type: "solid", color: "#111827" };
  }
  const stops = gradientStops(definition);
  if (stops.length === 0) {
    warn(state, "paint");
    return { type: "solid", color: "#111827" };
  }
  if (definition.tagName.toLowerCase() === "radialgradient") {
    const cx = normalizedGradientAttr(definition, "cx", 0.5);
    const cy = normalizedGradientAttr(definition, "cy", 0.5);
    const r = normalizedGradientAttr(definition, "r", 0.5);
    const fxRaw = definition.getAttribute("fx");
    const fyRaw = definition.getAttribute("fy");
    return {
      type: "radial-gradient",
      cx,
      cy,
      r,
      ...(fxRaw !== null && fyRaw !== null
        ? {
            fx: normalizedGradientAttr(definition, "fx", cx),
            fy: normalizedGradientAttr(definition, "fy", cy),
          }
        : {}),
      stops,
    };
  }
  if (definition.tagName.toLowerCase() === "lineargradient") {
    const start = {
      x: normalizedGradientAttr(definition, "x1", 0),
      y: normalizedGradientAttr(definition, "y1", 0),
    };
    const end = {
      x: normalizedGradientAttr(definition, "x2", 1),
      y: normalizedGradientAttr(definition, "y2", 0),
    };
    const markedAngle = Number(definition.getAttribute("data-openlogo-angle"));
    const angle = Number.isFinite(markedAngle)
      ? markedAngle
      : ((Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI +
          360) %
        360;
    return { type: "linear-gradient", angle, start, end, stops };
  }
  warn(state, "paint");
  return { type: "solid", color: "#111827" };
}

function parseEffects(filterId: string | undefined, state: WalkState): LogoEffect[] | undefined {
  if (!filterId) {
    return undefined;
  }
  const filter = state.filterDefinitions.get(filterId);
  if (!filter) {
    warn(state, "filter");
    return undefined;
  }
  const primitives = Array.from(filter.children).filter(
    (child) => child.tagName.toLowerCase() !== "femerge",
  );
  const hints = (filter.getAttribute("data-openlogo-effect-types") ?? "")
    .split(/\s+/)
    .filter(Boolean);
  if (primitives.length === 1 && primitives[0]!.tagName.toLowerCase() === "fedropshadow") {
    const shadow = primitives[0]!;
    const dx = numericAttr(shadow, "dx", 0);
    const dy = numericAttr(shadow, "dy", 0);
    const blur = numericAttr(shadow, "stdDeviation", 0) * 2;
    const color = styleValue(shadow, "flood-color") ?? "#000000";
    const opacity = numericAttr(shadow, "flood-opacity", 1);
    return hints[0] === "glow" || (hints.length === 0 && dx === 0 && dy === 0)
      ? [{ type: "glow", enabled: true, blur, color, opacity }]
      : [{ type: "drop-shadow", enabled: true, dx, dy, blur, color, opacity }];
  }

  const effects: LogoEffect[] = [];
  let primitiveIndex = 0;
  let effectIndex = 0;
  while (primitiveIndex < primitives.length) {
    const primitive = primitives[primitiveIndex]!;
    const tag = primitive.tagName.toLowerCase();
    if (
      tag === "fegaussianblur" &&
      primitives[primitiveIndex + 1]?.tagName.toLowerCase() === "feoffset" &&
      primitives[primitiveIndex + 2]?.tagName.toLowerCase() === "feflood" &&
      primitives[primitiveIndex + 3]?.tagName.toLowerCase() === "fecomposite"
    ) {
      const offset = primitives[primitiveIndex + 1]!;
      const flood = primitives[primitiveIndex + 2]!;
      const dx = numericAttr(offset, "dx", 0);
      const dy = numericAttr(offset, "dy", 0);
      const blur = numericAttr(primitive, "stdDeviation", 0) * 2;
      const color = styleValue(flood, "flood-color") ?? "#000000";
      const opacity = numericAttr(flood, "flood-opacity", 1);
      effects.push(
        hints[effectIndex] === "glow" ||
          (hints.length === 0 && dx === 0 && dy === 0)
          ? { type: "glow", enabled: true, blur, color, opacity }
          : { type: "drop-shadow", enabled: true, dx, dy, blur, color, opacity },
      );
      primitiveIndex += 4;
      effectIndex += 1;
      continue;
    }
    if (
      tag === "femorphology" &&
      primitives[primitiveIndex + 1]?.tagName.toLowerCase() === "feflood" &&
      primitives[primitiveIndex + 2]?.tagName.toLowerCase() === "fecomposite"
    ) {
      const flood = primitives[primitiveIndex + 1]!;
      effects.push({
        type: "outline",
        enabled: true,
        width: numericAttr(primitive, "radius", 0),
        color: styleValue(flood, "flood-color") ?? "#000000",
        opacity: numericAttr(flood, "flood-opacity", 1),
      });
      primitiveIndex += 3;
      effectIndex += 1;
      continue;
    }
    const fullBevelTags = primitives
      .slice(primitiveIndex, primitiveIndex + 12)
      .map((child) => child.tagName.toLowerCase());
    if (
      fullBevelTags.join(" ") ===
      "feoffset fecomposite fegaussianblur feflood fecomposite fecomposite feoffset fecomposite fegaussianblur feflood fecomposite fecomposite"
    ) {
      const offset = primitives[primitiveIndex]!;
      const blur = primitives[primitiveIndex + 2]!;
      const flood = primitives[primitiveIndex + 3]!;
      effects.push({
        type: "bevel",
        enabled: true,
        size: Math.abs(numericAttr(offset, "dx", 0)),
        soften: numericAttr(blur, "stdDeviation", 0) * 2,
        intensity: numericAttr(flood, "flood-opacity", 1),
      });
      primitiveIndex += 12;
      effectIndex += 1;
      continue;
    }
    warn(state, "filter");
    return undefined;
  }
  return effects.length > 0 ? effects : undefined;
}

function resolvedStroke(
  element: Element,
  presentation: Presentation,
  state: WalkState,
): Stroke | null {
  const marker = element.getAttribute("data-openlogo-stroke-align");
  const align = marker === "inside" || marker === "outside" ? marker : "center";
  const outsideColor = element.getAttribute("data-openlogo-stroke-color");
  const strokeValue =
    align === "outside" && outsideColor ? outsideColor : presentation.stroke;
  if (!strokeValue || strokeValue === "none") {
    return null;
  }
  const markedWidth = element.getAttribute("data-openlogo-stroke-width");
  const width = Math.max(
    0,
    (markedWidth !== null ? Number(markedWidth) : presentation.strokeWidth) *
      (align === "inside" && markedWidth === null ? 0.5 : 1),
  );
  const paint = paintFromValue(strokeValue, state);
  const fallback =
    element.getAttribute("data-openlogo-stroke-color") ??
    (paint.type === "solid" ? paint.color : "#111827");
  return {
    color: fallback,
    width,
    align,
    ...(paint.type === "solid" ? {} : { paint }),
  };
}

function markedNumber(element: Element, name: string): number | undefined {
  const raw = element.getAttribute(name);
  if (raw === null) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function parseFontFeatures(value: string | null): Record<string, boolean> | undefined {
  if (!value) {
    return undefined;
  }
  const features: Record<string, boolean> = {};
  for (const match of value.matchAll(/['"]([A-Za-z0-9]{4})['"]\s+(0|1|on|off)/g)) {
    features[match[1]!] = match[2] === "1" || match[2] === "on";
  }
  return Object.keys(features).length > 0 ? features : undefined;
}

function parseText(
  element: Element,
  parentMatrix: Mat,
  presentation: Presentation,
  ownerClipId: string | null,
  state: WalkState,
): void {
  const unsupportedChild = Array.from(element.children).find(
    (child) => !["tspan", "textpath"].includes(child.tagName.toLowerCase()),
  );
  if (unsupportedChild) {
    warn(state, "text");
    return;
  }
  const textPath = Array.from(element.children).find(
    (child) => child.tagName.toLowerCase() === "textpath",
  );
  const href = textPath?.getAttribute("href") ?? textPath?.getAttribute("xlink:href");
  const pathDefinitionId = href?.startsWith("#") ? href.slice(1) : undefined;
  if (textPath && (!pathDefinitionId || !state.pathDefinitions.has(pathDefinitionId))) {
    warn(state, "text");
    return;
  }
  const transform = element.getAttribute("transform")?.trim() ?? "";
  const rotationMatch = transform.match(
    /^rotate\(\s*(-?(?:\d+(?:\.\d+)?|\.\d+))(?:[\s,]+-?(?:\d+(?:\.\d+)?|\.\d+)){0,2}\s*\)$/,
  );
  const textRotation = rotationMatch ? Number(rotationMatch[1]) : undefined;
  if (
    !state.openLogo &&
    (parentMatrix.some(
      (value, index) => Math.abs(value - IDENTITY[index]!) > 1e-9,
    ) ||
      (transform !== "" && textRotation === undefined))
  ) {
    warn(state, "text");
    return;
  }

  const tspans = Array.from(element.children).filter(
    (child) => child.tagName.toLowerCase() === "tspan",
  );
  const content = textPath
    ? normalizeTextPathContent(textPath.textContent ?? "")
    : tspans.length > 0
      ? tspans.map((tspan) => tspan.textContent ?? "").join("\n")
      : (element.textContent ?? "");
  const inlineWidth = Number.parseFloat(styleValue(element, "inline-size") ?? "");
  const width =
    markedNumber(element, "data-openlogo-width") ??
    (Number.isFinite(inlineWidth) ? inlineWidth : 220);
  const height = markedNumber(element, "data-openlogo-height") ?? 56;
  const anchor = styleValue(element, "text-anchor")?.toLowerCase();
  const align = anchor === "middle" ? "center" : anchor === "end" ? "right" : "left";
  const anchorX = numericAttr(element, "x", 0);
  const x =
    markedNumber(element, "data-openlogo-x") ??
    (align === "center" ? anchorX - width / 2 : align === "right" ? anchorX - width : anchorX);
  const y = markedNumber(element, "data-openlogo-y") ?? numericAttr(element, "y", 0);
  const fontSize = numericAttr(element, "font-size", 44);
  const node = createText({ x, y, content });
  node.name = element.getAttribute("data-openlogo-name") ?? "Imported text";
  node.width = width;
  node.height = height;
  node.rotation =
    markedNumber(element, "data-openlogo-rotation") ?? textRotation ?? 0;
  node.opacity = presentation.opacity;
  node.visible = presentation.visible;
  node.fill = paintFromValue(presentation.fill, state);
  const stroke = resolvedStroke(element, presentation, state);
  if (stroke) {
    node.stroke = stroke;
  }
  node.fontFamily = styleValue(element, "font-family") ?? node.fontFamily;
  node.fontSize = fontSize;
  node.fontWeight = numericAttr(element, "font-weight", node.fontWeight);
  node.fontStyle = styleValue(element, "font-style") === "italic" ? "italic" : "normal";
  node.letterSpacing = numericAttr(element, "letter-spacing", 0);
  const lineHeight = Number(styleValue(element, "line-height"));
  node.lineHeight = Number.isFinite(lineHeight) ? lineHeight : node.lineHeight;
  node.align = align;
  const features = parseFontFeatures(styleValue(element, "font-feature-settings"));
  if (features) {
    node.otFeatures = features;
  }
  const markedKerning = element.getAttribute("data-openlogo-kerning");
  if (markedKerning) {
    try {
      node.kerning = JSON.parse(markedKerning) as Record<number, number>;
    } catch {
      warn(state, "text");
    }
  } else {
    const shifts = (element.getAttribute("dx") ?? "")
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    const kerning: Record<number, number> = {};
    for (let index = 1; index < shifts.length; index += 1) {
      if (Number.isFinite(shifts[index]) && shifts[index] !== 0) {
        kerning[index - 1] = (shifts[index]! / fontSize) * 1000;
      }
    }
    if (Object.keys(kerning).length > 0) {
      node.kerning = kerning;
    }
  }
  if (presentation.blendMode) {
    node.blendMode = presentation.blendMode;
  }
  const effects = parseEffects(presentation.filterId, state);
  if (effects) {
    node.effects = effects;
  }
  if (textPath) {
    const startOffset =
      markedNumber(element, "data-openlogo-path-start-offset") ??
      numericAttr(textPath, "startOffset", 0);
    node.onPath = {
      pathId: "",
      startOffset,
      flip:
        element.getAttribute("data-openlogo-path-flip") === "true" ||
        textPath.getAttribute("side") === "right",
    };
  }
  const sourceId = element.getAttribute("data-openlogo-source-id");
  const pathSourceId = element.getAttribute("data-openlogo-path-source-id");
  state.texts.push({
    id: nextFlatId(state, "text"),
    node,
    ...(sourceId ? { sourceId } : {}),
    ...(pathSourceId ? { pathSourceId } : {}),
    ...(pathDefinitionId ? { pathDefinitionId } : {}),
    ownerClipId,
    order: state.nextOrder++,
  });
}

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
  const definition = state.clipDefinitions.get(referenceId);
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
  state.pathChars += d.length;
  if (state.pathChars > MAX_SVG_IMPORT_PATH_CHARS) {
    state.limitExceeded = true;
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
    fill: { type: "solid", color: "#000000" },
    fillRule,
    opacity: 1,
    stroke: null,
    name: "Clipping path",
    visible: true,
    ownerClipId: id,
    order,
  };
  state.clips.push({ id, parentClipId, mask, order });
  return id;
}

function walk(
  element: Element,
  matrix: Mat,
  inherited: Presentation,
  ownerClipId: string | null,
  state: WalkState,
  depth = 0,
): void {
  if (state.limitExceeded || depth > MAX_SVG_IMPORT_DEPTH) {
    state.limitExceeded = true;
    return;
  }
  const localMatrix = multiply(
    matrix,
    parseTransform(element.getAttribute("transform")),
  );
  const fillRaw = styleValue(element, "fill");
  const fill = fillRaw ?? inherited.fill;
  const strokeRaw = styleValue(element, "stroke");
  const stroke = strokeRaw ?? inherited.stroke;
  const rawStrokeWidth = Number(
    styleValue(element, "stroke-width") ?? inherited.strokeWidth,
  );
  const strokeWidth = Number.isFinite(rawStrokeWidth)
    ? Math.max(0, rawStrokeWidth)
    : inherited.strokeWidth;
  const fillRuleRaw = styleValue(element, "fill-rule")?.trim().toLowerCase();
  const fillRule =
    fillRuleRaw === "initial"
      ? "nonzero"
      : fillRuleRaw === "evenodd" || fillRuleRaw === "nonzero"
        ? fillRuleRaw
        : inherited.fillRule;
  const ownOpacity = Number(styleValue(element, "opacity") ?? 1);
  const opacity =
    inherited.opacity *
    (Number.isFinite(ownOpacity) ? Math.min(1, Math.max(0, ownOpacity)) : 1);
  const visible =
    inherited.visible &&
    styleValue(element, "display") !== "none" &&
    element.getAttribute("data-openlogo-visible") !== "false";
  const blendRaw = styleValue(element, "mix-blend-mode");
  const blendMode = BLEND_MODES.has(blendRaw as BlendMode)
    ? (blendRaw as BlendMode)
    : inherited.blendMode;
  const filterId =
    paintReferenceId(styleValue(element, "filter")) ?? inherited.filterId;
  const presentation: Presentation = {
    fill,
    stroke,
    strokeWidth,
    fillRule,
    opacity,
    visible,
    ...(blendMode ? { blendMode } : {}),
    ...(filterId ? { filterId } : {}),
  };

  const tag = element.tagName.toLowerCase();
  if (tag === "g" || tag === "svg") {
    if (tag === "g" && element.hasAttribute("data-openlogo-name")) {
      warn(state, "group");
    }
    const nextOwner =
      tag === "g"
        ? (captureClipGroup(element, localMatrix, ownerClipId, state) ??
          ownerClipId)
        : ownerClipId;
    for (const child of Array.from(element.children)) {
      walk(
        child,
        localMatrix,
        presentation,
        nextOwner,
        state,
        depth + 1,
      );
    }
    return;
  }
  if (tag === "text") {
    parseText(element, matrix, presentation, ownerClipId, state);
    return;
  }
  if (tag === "defs" || tag === "clippath" || tag === "mask") {
    return;
  }
  if (element.getAttribute("data-openlogo-stroke-decoration") === "true") {
    return;
  }
  if (element.getAttribute("data-openlogo-artboard-background") === "true") {
    return;
  }
  if (
    state.openLogo &&
    tag === "rect" &&
    element.getAttribute("data-openlogo-source-id") === null &&
    element.getAttribute("width") === "100%" &&
    element.getAttribute("height") === "100%"
  ) {
    return;
  }

  const d = shapeToPathData(element);
  if (!d) {
    return;
  }
  state.pathChars += d.length;
  if (state.pathChars > MAX_SVG_IMPORT_PATH_CHARS) {
    state.limitExceeded = true;
    return;
  }

  const resolvedFill = paintFromValue(fill, state);
  const resolvedNodeStroke = resolvedStroke(element, presentation, state);
  const transparentFill =
    resolvedFill.type === "solid" &&
    ["none", "transparent", "#00000000", "#0000"].includes(
      resolvedFill.color.toLowerCase(),
    );
  if (transparentFill && !resolvedNodeStroke && !state.openLogo) {
    return;
  }

  const nodeType = element.getAttribute("data-openlogo-node-type");
  const supportedNodeType =
    nodeType === "path" || nodeType === "rectangle" || nodeType === "ellipse"
      ? nodeType
      : undefined;
  const effects = filterId ? parseEffects(filterId, state) : undefined;
  const sourceId = element.getAttribute("data-openlogo-source-id");
  const x = markedNumber(element, "data-openlogo-x");
  const y = markedNumber(element, "data-openlogo-y");
  const width = markedNumber(element, "data-openlogo-width");
  const height = markedNumber(element, "data-openlogo-height");
  const rotation = markedNumber(element, "data-openlogo-rotation");
  const intrinsicWidth = markedNumber(element, "data-openlogo-intrinsic-width");
  const intrinsicHeight = markedNumber(element, "data-openlogo-intrinsic-height");
  const cornerRadius = markedNumber(element, "data-openlogo-corner-radius");

  state.shapes.push({
    id: nextFlatId(state, "shape"),
    d,
    matrix: localMatrix,
    fill: resolvedFill,
    fillRule,
    opacity,
    stroke: resolvedNodeStroke,
    name: element.getAttribute("data-openlogo-name") ?? `Imported ${state.shapes.length + 1}`,
    visible,
    ...(blendMode ? { blendMode } : {}),
    ...(effects ? { effects } : {}),
    ...(sourceId ? { sourceId } : {}),
    ...(supportedNodeType ? { nodeType: supportedNodeType } : {}),
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(rotation !== undefined ? { rotation } : {}),
    ...(intrinsicWidth !== undefined ? { intrinsicWidth } : {}),
    ...(intrinsicHeight !== undefined ? { intrinsicHeight } : {}),
    ...(cornerRadius !== undefined ? { cornerRadius } : {}),
    ownerClipId,
    order: state.nextOrder++,
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
): Effect.Effect<LogoNode | null> {
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
): LogoNode | null {
  const markedBox =
    shape.nodeType &&
    shape.x !== undefined &&
    shape.y !== undefined &&
    shape.width !== undefined &&
    shape.height !== undefined;
  if (markedBox) {
    const common = {
      name: shape.name,
      x: shape.x!,
      y: shape.y!,
      width: shape.width!,
      height: shape.height!,
      rotation: shape.rotation ?? 0,
      opacity: Number.isFinite(shape.opacity)
        ? Math.max(0, Math.min(1, shape.opacity))
        : 1,
      visible: shape.visible,
      fill: shape.fill,
      ...(shape.stroke ? { stroke: shape.stroke } : {}),
      ...(shape.blendMode ? { blendMode: shape.blendMode } : {}),
      ...(shape.effects ? { effects: shape.effects } : {}),
    };
    if (shape.nodeType === "rectangle") {
      return {
        ...createRectangle({ x: shape.x!, y: shape.y! }),
        ...common,
        cornerRadius: shape.cornerRadius ?? 0,
      } satisfies RectangleNode;
    }
    if (shape.nodeType === "ellipse") {
      return { ...createEllipse({ x: shape.x!, y: shape.y! }), ...common };
    }
    const geometry = pathCommandsToGeometry(path.toCmds());
    return {
      id: createId("node"),
      type: "path",
      locked: false,
      ...common,
      d: shape.d,
      fillRule: shape.fillRule,
      ...(geometry ? { geometry } : {}),
      intrinsicWidth: shape.intrinsicWidth ?? shape.width!,
      intrinsicHeight: shape.intrinsicHeight ?? shape.height!,
    } satisfies PathNode;
  }

  const [a, b, c, d2, e, f] = shape.matrix;
  const strokeWidth = shape.stroke
    ? transformedStrokeWidth(shape.stroke.width, shape.matrix)
    : 0;
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
    name: shape.name || `Imported ${index + 1}`,
    x: left,
    y: top,
    width,
    height,
    rotation: 0,
    opacity: Number.isFinite(shape.opacity)
      ? Math.max(0, Math.min(1, shape.opacity))
      : 1,
    visible: shape.visible,
    locked: false,
    fill: shape.fill,
    fillRule: shape.fillRule,
    ...(shape.stroke
      ? {
          stroke: {
            color: shape.stroke.color,
            width: strokeWidth,
            align: shape.stroke.align,
            ...(shape.stroke.paint ? { paint: shape.stroke.paint } : {}),
          },
        }
      : {}),
    ...(shape.blendMode ? { blendMode: shape.blendMode } : {}),
    ...(shape.effects ? { effects: shape.effects } : {}),
    d: normalized,
    geometry,
    intrinsicWidth: width,
    intrinsicHeight: height,
  };
}

/** Scalar approximation for SVG strokes baked through an affine transform. */
export function transformedStrokeWidth(
  width: number,
  matrix: SvgTransformMatrix,
): number {
  const [a, b, c, d] = matrix;
  const scale = Math.max(Math.hypot(a, b), Math.hypot(c, d));
  return Math.max(
    0,
    width * (Number.isFinite(scale) && scale > 0 ? scale : 1),
  );
}

/**
 * Import an SVG string as one group of path nodes. Succeeds with [groupId]
 * ([] when nothing importable); unparseable input is an empty result, not
 * an error — only a CanvasKit load failure lands in the error channel.
 */
export const importSvg = (
  svgText: string,
): Effect.Effect<SvgImportResult, CanvasKitLoadError | SvgImportError> =>
  Effect.gen(function* () {
    if (svgText.length > MAX_SVG_IMPORT_BYTES) {
      return yield* Effect.fail(
        new SvgImportError({
          reason: "SVG import is limited to 5 MB for reliable local editing.",
        }),
      );
    }
    const sourceDocument = documentStore.committedDocument;
    const generation = documentStore.documentGeneration;
    const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const root = parsed.querySelector("svg");
    if (!root || parsed.querySelector("parsererror")) {
      return importResult([], new Map());
    }
    const allElements = Array.from(root.querySelectorAll("*"));
    if (allElements.length > MAX_SVG_IMPORT_ELEMENTS) {
      return yield* Effect.fail(
        new SvgImportError({
          reason: `SVG import is limited to ${MAX_SVG_IMPORT_ELEMENTS.toLocaleString()} elements.`,
        }),
      );
    }
    const clipDefinitions = new Map<string, Element>();
    const paintDefinitions = new Map<string, Element>();
    const filterDefinitions = new Map<string, Element>();
    const pathDefinitions = new Map<string, Element>();
    for (const element of allElements) {
      const tag = element.tagName.toLowerCase();
      const id = element.getAttribute("id");
      if (id) {
        if (tag === "clippath") {
          clipDefinitions.set(id, element);
        } else if (
          tag === "lineargradient" ||
          tag === "radialgradient" ||
          tag === "pattern"
        ) {
          paintDefinitions.set(id, element);
        } else if (tag === "filter") {
          filterDefinitions.set(id, element);
        } else if (tag === "path") {
          pathDefinitions.set(id, element);
        }
      }
    }

    const state: WalkState = {
      clipDefinitions,
      paintDefinitions,
      filterDefinitions,
      pathDefinitions,
      shapes: [],
      texts: [],
      clips: [],
      warnings: new Map(),
      openLogo: root.hasAttribute("data-openlogo-version"),
      nextId: 0,
      nextOrder: 0,
      pathChars: 0,
      limitExceeded: false,
    };
    walk(
      root,
      IDENTITY,
      {
        fill: "#000000",
        stroke: null,
        strokeWidth: 1,
        fillRule: "nonzero",
        opacity: 1,
        visible: true,
      },
      null,
      state,
    );
    if (state.limitExceeded) {
      return yield* Effect.fail(
        new SvgImportError({
          reason:
            "This SVG is too complex to import safely. Simplify its paths or group depth and try again.",
        }),
      );
    }
    if (state.shapes.length === 0 && state.texts.length === 0) {
      return importResult([], state.warnings);
    }

    const matricesEqual = (left: Mat, right: Mat) =>
      left.every((value, index) => Math.abs(value - right[index]!) < 1e-6);
    const definitionShapes = new Map<string, FlatShape>();
    for (const text of state.texts) {
      if (!text.node.onPath || !text.pathDefinitionId) {
        continue;
      }
      const definition = pathDefinitions.get(text.pathDefinitionId);
      if (!definition) {
        continue;
      }
      const d = shapeToPathData(definition);
      if (!d) {
        warn(state, "text");
        continue;
      }
      const definitionMatrix = parseTransform(definition.getAttribute("transform"));
      const sourceId =
        text.pathSourceId ??
        definition.getAttribute("data-openlogo-path-source-id") ??
        undefined;
      const matched = state.shapes.find(
        (shape) =>
          (sourceId !== undefined && shape.sourceId === sourceId) ||
          (shape.d === d && matricesEqual(shape.matrix, definitionMatrix)),
      );
      if (matched) {
        text.pathFlatId = matched.id;
        continue;
      }
      const existingDefinitionShape = definitionShapes.get(text.pathDefinitionId);
      if (existingDefinitionShape) {
        text.pathFlatId = existingDefinitionShape.id;
      } else {
        const definitionShape: FlatShape = {
          id: nextFlatId(state, "text-path"),
          d,
          matrix: definitionMatrix,
          fill: { type: "solid", color: "#00000000" },
          fillRule: "nonzero",
          opacity: 1,
          stroke: null,
          name: "Text path",
          visible: false,
          ...(sourceId ? { sourceId } : {}),
          ownerClipId: text.ownerClipId,
          order: text.order - 0.5,
        };
        definitionShapes.set(text.pathDefinitionId, definitionShape);
        state.shapes.push(definitionShape);
        text.pathFlatId = definitionShape.id;
      }
    }

    const flatShapes = [
      ...state.shapes,
      ...state.clips.map((clip) => clip.mask),
    ];
    const ck = flatShapes.length > 0 ? yield* canvasKit : null;
    const built = (yield* Effect.all(
      flatShapes.map((shape, index) =>
        buildNode(ck!, shape, index).pipe(
          Effect.map((node) => (node ? { shape, node } : null)),
        ),
      ),
    )).filter(
      (item): item is { shape: FlatShape; node: LogoNode } => item !== null,
    );
    const builtByFlatId = new Map(
      built.map(({ shape, node }) => [shape.id, node] as const),
    );
    const sourceIds = new Map(
      built
        .filter(({ shape }) => shape.sourceId !== undefined)
        .map(({ shape, node }) => [shape.sourceId!, node.id] as const),
    );
    const builtTexts = state.texts
      .filter((text) => {
        if (!text.node.onPath) {
          return true;
        }
        const pathId =
          (text.pathSourceId ? sourceIds.get(text.pathSourceId) : undefined) ??
          (text.pathFlatId ? builtByFlatId.get(text.pathFlatId)?.id : undefined);
        if (!pathId) {
          warn(state, "text");
          return false;
        }
        text.node.onPath.pathId = pathId;
        return true;
      })
      .map((text) => ({ text, node: text.node as LogoNode }));
    if (built.length === 0 && builtTexts.length === 0) {
      return importResult([], state.warnings);
    }

    // Fit and centre on the artboard.
    const currentDocument = documentStore.committedDocument;
    if (
      documentStore.documentGeneration !== generation ||
      currentDocument.activeArtboardId !== sourceDocument.activeArtboardId
    ) {
      return importResult([], state.warnings);
    }
    const artboard = getActiveArtboard(currentDocument);
    const allBuiltNodes = [
      ...built.map(({ node }) => node),
      ...builtTexts.map(({ node }) => node),
    ];
    const minX = Math.min(...allBuiltNodes.map((node) => node.x));
    const minY = Math.min(...allBuiltNodes.map((node) => node.y));
    const maxX = Math.max(...allBuiltNodes.map((node) => node.x + node.width));
    const maxY = Math.max(...allBuiltNodes.map((node) => node.y + node.height));
    const spanW = maxX - minX;
    const spanH = maxY - minY;
    const scale = state.openLogo
      ? 1
      : Math.min(
          1,
          (artboard.width * 0.8) / spanW,
          (artboard.height * 0.8) / spanH,
        );
    const offsetX = state.openLogo
      ? 0
      : (artboard.width - spanW * scale) / 2 - minX * scale;
    const offsetY = state.openLogo
      ? 0
      : (artboard.height - spanH * scale) / 2 - minY * scale;

    const placed = built.map(({ shape, node }) => ({
      shape,
      node: {
        ...node,
        x: node.x * scale + offsetX,
        y: node.y * scale + offsetY,
        width: node.width * scale,
        height: node.height * scale,
        // Path data stays in intrinsic space; only the box scales.
      } as LogoNode,
    }));
    const placedTexts = builtTexts.map(({ text, node }) => ({
      text,
      node: {
        ...node,
        x: node.x * scale + offsetX,
        y: node.y * scale + offsetY,
        width: node.width * scale,
        height: node.height * scale,
        ...(node.type === "text"
          ? {
              fontSize: node.fontSize * scale,
              letterSpacing: node.letterSpacing * scale,
              ...(node.stroke
                ? { stroke: { ...node.stroke, width: node.stroke.width * scale } }
                : {}),
              ...(node.onPath
                ? {
                    onPath: {
                      ...node.onPath,
                      startOffset: node.onPath.startOffset * scale,
                    },
                  }
                : {}),
            }
          : {}),
      } as TextNode,
    }));
    const placedByFlatId = new Map(
      [
        ...placed.map((item) => [item.shape.id, item.node] as const),
        ...placedTexts.map((item) => [item.text.id, item.node] as const),
      ],
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
        ...state.texts
          .filter((text) => text.ownerClipId === clip.id)
          .map((text) => ({
            id: placedByFlatId.get(text.id)?.id ?? "",
            order: text.order,
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
      ...state.texts
        .filter((text) => text.ownerClipId === null)
        .map((text) => ({
          id: placedByFlatId.get(text.id)?.id ?? "",
          order: text.order,
        })),
      ...state.clips
        .filter((clip) => clip.parentClipId === null)
        .map((clip) => groupsByClipId.get(clip.id))
        .filter((item): item is OrderedNode => item !== undefined),
    ]
      .filter((item) => item.id !== "")
      .sort((a, b) => a.order - b.order);
    if (roots.length === 0) {
      return importResult([], state.warnings);
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
      ...placedTexts.map(({ node }) => [node.id, node] as const),
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
    return importResult(rootIds, state.warnings);
  });
