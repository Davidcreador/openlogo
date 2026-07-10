import { Data, Effect } from "effect";
import {
  type Artboard,
  type Bounds,
  type LinearGradientPaint,
  type LogoDocument,
  type LogoNode,
  type Paint,
  type PathNode,
  type RadialGradientPaint,
  type TextNode,
  getActiveArtboard,
  kernAt,
  kernToPx,
  linearGradientPoints,
  paintBounds,
  pathGeometryToSvg,
  reversePathGeometry,
} from "@openlogo/core";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

let gradientCounter = 0;
let filterCounter = 0;
let textPathCounter = 0;
let clippingPathCounter = 0;

/**
 * Layer effects → an SVG <filter>. Faithful pieces: drop shadow and glow
 * (feDropShadow / blur+offset+flood chains), outline (feMorphology
 * dilate). Bevel exports the same approximation the renderer draws — two
 * blurred offset silhouette copies clipped inside the source alpha —
 * not a real lighting model. Known degradations vs the canvas: stacked
 * shadows are built from SourceAlpha (they don't shadow each other),
 * and feMorphology's square kernel rounds corners slightly differently
 * from Skia's dilate.
 */
function effectsAttr(node: LogoNode, defs: string[]): string {
  const effects = node.effects?.filter((effect) => effect.enabled) ?? [];
  if (effects.length === 0) {
    return "";
  }

  filterCounter += 1;
  const id = `fx-${filterCounter}`;
  const region = `x="-60%" y="-60%" width="220%" height="220%"`;

  // Single drop shadow / glow: the native primitive, nothing else.
  if (
    effects.length === 1 &&
    (effects[0]!.type === "drop-shadow" || effects[0]!.type === "glow")
  ) {
    const effect = effects[0]!;
    const dx = effect.type === "drop-shadow" ? effect.dx : 0;
    const dy = effect.type === "drop-shadow" ? effect.dy : 0;
    defs.push(
      `<filter id="${id}" ${region}><feDropShadow dx="${dx}" dy="${dy}" stdDeviation="${
        effect.blur / 2
      }" flood-color="${escapeXml(effect.color)}" flood-opacity="${effect.opacity}" /></filter>`,
    );
    return ` filter="url(#${id})"`;
  }

  const primitives: string[] = [];
  const under: string[] = [];
  const over: string[] = [];
  let step = 0;

  for (const effect of effects) {
    step += 1;
    if (effect.type === "drop-shadow" || effect.type === "glow") {
      const dx = effect.type === "drop-shadow" ? effect.dx : 0;
      const dy = effect.type === "drop-shadow" ? effect.dy : 0;
      primitives.push(
        `<feGaussianBlur in="SourceAlpha" stdDeviation="${effect.blur / 2}" result="b${step}" />`,
        `<feOffset in="b${step}" dx="${dx}" dy="${dy}" result="o${step}" />`,
        `<feFlood flood-color="${escapeXml(effect.color)}" flood-opacity="${effect.opacity}" result="c${step}" />`,
        `<feComposite in="c${step}" in2="o${step}" operator="in" result="u${step}" />`,
      );
      under.push(`u${step}`);
    } else if (effect.type === "outline") {
      if (effect.width <= 0) {
        continue;
      }
      primitives.push(
        `<feMorphology in="SourceAlpha" operator="dilate" radius="${effect.width}" result="m${step}" />`,
        `<feFlood flood-color="${escapeXml(effect.color)}" flood-opacity="${effect.opacity}" result="c${step}" />`,
        `<feComposite in="c${step}" in2="m${step}" operator="in" result="u${step}" />`,
      );
      under.push(`u${step}`);
    } else {
      // Bevel: edge rims — the silhouette minus itself shifted away from
      // the light — lit toward the top-left, shaded toward the
      // bottom-right, blurred and clipped inside the source. Mirrors the
      // renderer's DstOut construction.
      const passes = [
        { sign: -1, color: "#ffffff", key: "h" },
        { sign: 1, color: "#000000", key: "s" },
      ];
      for (const pass of passes) {
        const p = `${pass.key}${step}`;
        primitives.push(
          `<feOffset in="SourceAlpha" dx="${-pass.sign * effect.size}" dy="${-pass.sign * effect.size}" result="${p}o" />`,
          `<feComposite in="SourceAlpha" in2="${p}o" operator="out" result="${p}r" />`,
          `<feGaussianBlur in="${p}r" stdDeviation="${effect.soften / 2}" result="${p}b" />`,
          `<feFlood flood-color="${pass.color}" flood-opacity="${effect.intensity}" result="${p}c" />`,
          `<feComposite in="${p}c" in2="${p}b" operator="in" result="${p}i" />`,
          `<feComposite in="${p}i" in2="SourceAlpha" operator="in" result="${p}" />`,
        );
        over.push(p);
      }
    }
  }

  if (primitives.length === 0) {
    return "";
  }

  const merge = [
    ...under.map((result) => `<feMergeNode in="${result}" />`),
    `<feMergeNode in="SourceGraphic" />`,
    ...over.map((result) => `<feMergeNode in="${result}" />`),
  ].join("");
  primitives.push(`<feMerge>${merge}</feMerge>`);
  defs.push(`<filter id="${id}" ${region}>${primitives.join("")}</filter>`);
  return ` filter="url(#${id})"`;
}

/**
 * Text on a path exports as a real <textPath> (editable text, faithful
 * startOffset). Flip uses the REVERSED path in defs — same layout the
 * renderer draws — when structured geometry exists; imported `d`-only
 * paths degrade to SVG2's side="right", which some renderers ignore.
 * Fonts are referenced by family name, like every text export here.
 */
/**
 * Typography attributes shared by both <text> forms: italic slant,
 * OpenType feature toggles (CSS font-feature-settings) and manual
 * per-pair kerning as a per-glyph `dx` list (dx[i] shifts glyph i, i.e.
 * the gap after glyph i−1 — matching the renderer's pair map).
 */
function textTypographyAttrs(node: TextNode): string {
  const italic = node.fontStyle === "italic" ? ` font-style="italic"` : "";
  let dx = "";
  if (node.kerning && Object.keys(node.kerning).length > 0) {
    const shifts = Array.from(node.content, (_char, i) =>
      i === 0 ? 0 : kernToPx(kernAt(node.kerning, i - 1), node.fontSize),
    );
    dx = ` dx="${shifts.map((v) => Math.round(v * 1000) / 1000).join(" ")}"`;
  }
  return `${italic}${dx}`;
}

/** OpenType toggles as a CSS declaration (joined into the style attr). */
function fontFeatureDecl(node: TextNode): string | null {
  if (!node.otFeatures) {
    return null;
  }
  const settings = Object.entries(node.otFeatures)
    // OpenType feature tags are exactly four ASCII alphanumerics. Besides
    // producing valid CSS, filtering here prevents imported documents from
    // smuggling arbitrary declarations into the inline style attribute.
    .filter(([tag]) => /^[A-Za-z0-9]{4}$/.test(tag))
    .map(([tag, on]) => `'${tag}' ${on ? 1 : 0}`)
    .join(", ");
  return settings ? `font-feature-settings: ${settings}` : null;
}

function textOnPathMarkup(
  node: TextNode,
  path: PathNode,
  base: string,
  defs: string[],
): string {
  const attachment = node.onPath!;
  textPathCounter += 1;
  const id = `tp-${textPathCounter}`;

  let d = path.d;
  let side = "";
  if (attachment.flip) {
    if (path.geometry) {
      d = pathGeometryToSvg(reversePathGeometry(path.geometry));
    } else {
      side = ' side="right"';
    }
  }

  const rotate =
    path.rotation === 0
      ? ""
      : `rotate(${path.rotation} ${path.x + path.width / 2} ${
          path.y + path.height / 2
        }) `;
  const transform = `${rotate}translate(${path.x} ${path.y}) scale(${
    path.width / path.intrinsicWidth
  } ${path.height / path.intrinsicHeight})`;
  defs.push(
    `<path id="${id}" d="${escapeXml(d)}" transform="${transform}" fill="none" />`,
  );

  return `<text ${base} font-family="${escapeXml(node.fontFamily)}" font-size="${
    node.fontSize
  }" font-weight="${node.fontWeight}"${textTypographyAttrs(node)} letter-spacing="${
    node.letterSpacing
  }"><textPath href="#${id}"${side} startOffset="${
    attachment.startOffset
  }">${escapeXml(node.content)}</textPath></text>`;
}

function gradientStops(paint: LinearGradientPaint | RadialGradientPaint): string {
  return paint.stops
    .map(
      (stop) =>
        `<stop offset="${stop.offset}" stop-color="${escapeXml(stop.color)}"${
          stop.alpha !== undefined && stop.alpha < 1
            ? ` stop-opacity="${stop.alpha}"`
            : ""
        } />`,
    )
    .join("");
}

function paintAttr(paint: Paint, defs: string[], box: Bounds): string {
  if (paint.type === "solid") {
    return escapeXml(paint.color);
  }

  gradientCounter += 1;
  const id = `grad-${gradientCounter}`;
  const stops = gradientStops(paint);

  if (paint.type === "radial-gradient") {
    // Normalized document coordinates ARE objectBoundingBox units, so
    // this def matches the renderer's box-matrix shader exactly.
    const focal =
      paint.fx !== undefined && paint.fy !== undefined
        ? ` fx="${paint.fx}" fy="${paint.fy}"`
        : "";
    defs.push(
      `<radialGradient id="${id}" cx="${paint.cx}" cy="${paint.cy}" r="${paint.r}"${focal}>${stops}</radialGradient>`,
    );
    return `url(#${id})`;
  }

  if (paint.start && paint.end) {
    defs.push(
      `<linearGradient id="${id}" x1="${paint.start.x}" y1="${paint.start.y}" x2="${paint.end.x}" y2="${paint.end.y}">${stops}</linearGradient>`,
    );
    return `url(#${id})`;
  }

  // Legacy angle-only gradients use the exact same absolute-space vector as
  // the renderer. Object-bounding-box coordinates may legitimately be
  // outside 0..1 for non-square nodes.
  const points = linearGradientPoints(paint, box);
  const width = Math.max(1, box.width);
  const height = Math.max(1, box.height);
  const x1 = (points.start.x - box.x) / width;
  const y1 = (points.start.y - box.y) / height;
  const x2 = (points.end.x - box.x) / width;
  const y2 = (points.end.y - box.y) / height;
  defs.push(
    `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient>`,
  );
  return `url(#${id})`;
}

/** Match the renderer's gradient coordinate space. */
function nodePaintBox(node: Exclude<LogoNode, { type: "group" }>): Bounds {
  return node.type === "path"
    ? {
        x: 0,
        y: 0,
        width: node.intrinsicWidth,
        height: node.intrinsicHeight,
      }
    : { x: node.x, y: node.y, width: node.width, height: node.height };
}

function renderNode(
  document: LogoDocument,
  node: LogoNode,
  defs: string[],
): string {
  if (node.type === "group") {
    return ""; // handled by renderTree
  }

  const rotate =
    node.rotation === 0
      ? ""
      : ` transform="rotate(${node.rotation} ${node.x + node.width / 2} ${
          node.y + node.height / 2
        })"`;
  const paintBox = nodePaintBox(node);
  const fill = paintAttr(node.fill, defs, paintBox);
  const stroke = node.stroke
    ? ` stroke="${
        node.stroke.paint
          ? paintAttr(node.stroke.paint, defs, paintBox)
          : escapeXml(node.stroke.color)
      }" stroke-width="${node.stroke.width}"`
    : "";
  const styleDecls = [
    node.blendMode ? `mix-blend-mode:${node.blendMode}` : null,
    node.type === "text" ? fontFeatureDecl(node) : null,
    node.type === "text" ? `line-height:${node.lineHeight}` : null,
    node.type === "text" ? "white-space:pre-wrap" : null,
    node.type === "text" ? `inline-size:${node.width}px` : null,
  ].filter(Boolean);
  const blend =
    styleDecls.length > 0
      ? ` style="${escapeXml(styleDecls.join(";"))}"`
      : "";
  const filter = effectsAttr(node, defs);
  const base = `opacity="${node.opacity}" fill="${fill}"${stroke}${blend}${filter}${rotate}`;

  if (node.type === "rectangle") {
    return `<rect ${base} x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${node.cornerRadius}" />`;
  }

  if (node.type === "ellipse") {
    return `<ellipse ${base} cx="${node.x + node.width / 2}" cy="${
      node.y + node.height / 2
    }" rx="${node.width / 2}" ry="${node.height / 2}" />`;
  }

  if (node.type === "text") {
    const pathTarget = node.onPath
      ? document.nodes[node.onPath.pathId]
      : undefined;
    if (node.onPath && pathTarget?.type === "path") {
      return textOnPathMarkup(node, pathTarget, base, defs);
    }

    const anchor =
      node.align === "center"
        ? ' text-anchor="middle"'
        : node.align === "right"
          ? ' text-anchor="end"'
          : "";
    const anchorX =
      node.align === "center"
        ? node.x + node.width / 2
        : node.align === "right"
          ? node.x + node.width
          : node.x;

    const lines = node.content.split("\n");
    const content =
      lines.length === 1
        ? escapeXml(node.content)
        : lines
            .map(
              (line, index) =>
                `<tspan x="${anchorX}" y="${
                  node.y + index * node.fontSize * node.lineHeight
                }">${escapeXml(line)}</tspan>`,
            )
            .join("");

    return `<text ${base}${anchor} x="${anchorX}" y="${node.y}" dominant-baseline="text-before-edge" font-family="${escapeXml(node.fontFamily)}" font-size="${
      node.fontSize
    }" font-weight="${node.fontWeight}"${textTypographyAttrs(node)} letter-spacing="${
      node.letterSpacing
    }">${content}</text>`;
  }

  // path
  const transform = `translate(${node.x} ${node.y}) scale(${
    node.width / node.intrinsicWidth
  } ${node.height / node.intrinsicHeight})`;
  const pathRotate =
    node.rotation === 0
      ? ""
      : `rotate(${node.rotation} ${node.x + node.width / 2} ${
          node.y + node.height / 2
        }) `;

  return `<g opacity="${node.opacity}" fill="${fill}"${stroke}${blend}${filter} transform="${pathRotate}${transform}"><path fill-rule="${node.fillRule}" d="${escapeXml(
    node.d,
  )}" /></g>`;
}

/** Geometry-only SVG for a clipping path; paint, stroke and opacity do not. */
function renderClippingGeometry(node: LogoNode): string | null {
  if (node.type === "group" || node.type === "text") {
    return null;
  }
  const rotate =
    node.rotation === 0
      ? ""
      : ` transform="rotate(${node.rotation} ${node.x + node.width / 2} ${
          node.y + node.height / 2
        })"`;
  if (node.type === "rectangle") {
    return `<rect${rotate} x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${node.cornerRadius}" />`;
  }
  if (node.type === "ellipse") {
    return `<ellipse${rotate} cx="${node.x + node.width / 2}" cy="${
      node.y + node.height / 2
    }" rx="${node.width / 2}" ry="${node.height / 2}" />`;
  }

  const boxTransform = `translate(${node.x} ${node.y}) scale(${
    node.width / node.intrinsicWidth
  } ${node.height / node.intrinsicHeight})`;
  const pathRotate =
    node.rotation === 0
      ? ""
      : `rotate(${node.rotation} ${node.x + node.width / 2} ${
          node.y + node.height / 2
        }) `;
  return `<path clip-rule="${node.fillRule}" transform="${pathRotate}${boxTransform}" d="${escapeXml(
    node.d,
  )}" />`;
}

/** Render a node subtree; groups become real nested `<g>` elements. */
function renderTree(
  document: LogoDocument,
  nodeId: string,
  defs: string[],
): string {
  const node = document.nodes[nodeId];
  if (!node || !node.visible) {
    return "";
  }

  if (node.type === "group") {
    let clipping = "";
    let childIds = node.children;
    if (node.clippingMaskId) {
      const mask = document.nodes[node.clippingMaskId];
      const geometry = mask ? renderClippingGeometry(mask) : null;
      if (!geometry || !node.children.includes(node.clippingMaskId)) {
        return ""; // malformed relationship fails closed
      }
      clippingPathCounter += 1;
      const id = `clip-${clippingPathCounter}`;
      defs.push(
        `<clipPath id="${id}" clipPathUnits="userSpaceOnUse">${geometry}</clipPath>`,
      );
      clipping = ` clip-path="url(#${id})"`;
      childIds = node.children.filter((id) => id !== node.clippingMaskId);
    }
    const inner = childIds
      .map((childId) => renderTree(document, childId, defs))
      .filter(Boolean)
      .join("\n  ");
    if (!inner) {
      return "";
    }
    const opacity = node.opacity !== 1 ? ` opacity="${node.opacity}"` : "";
    // mix-blend-mode on a <g> blends the group as one unit against the
    // backdrop — same semantics as the renderer's saveLayer.
    const blend = node.blendMode
      ? ` style="mix-blend-mode:${node.blendMode}"`
      : "";
    const filter = effectsAttr(node, defs);
    return `<g${opacity}${blend}${filter}${clipping} data-name="${escapeXml(node.name)}">\n  ${inner}\n  </g>`;
  }

  return renderNode(document, node, defs);
}

export type SvgExportOptions = {
  /** Skip the artboard background rect (transparent PNG/SVG exports). */
  transparentBackground?: boolean;
};

export function documentToSvg(
  document: LogoDocument,
  artboard: Artboard = getActiveArtboard(document),
  options: SvgExportOptions = {},
): string {
  const defs: string[] = [];
  const body = artboard.nodeIds
    .map((nodeId) => renderTree(document, nodeId, defs))
    .filter(Boolean)
    .join("\n  ");
  const defsBlock = defs.length > 0 ? `\n  <defs>${defs.join("")}</defs>` : "";
  const background = options.transparentBackground
    ? ""
    : `\n  <rect width="100%" height="100%" fill="${escapeXml(artboard.background)}" />`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${artboard.width}" height="${artboard.height}" viewBox="0 0 ${artboard.width} ${artboard.height}" role="img" aria-label="${escapeXml(
    artboard.name,
  )}">${defsBlock}${background}
  ${body}
</svg>`;
}

/**
 * Standalone SVG of just the given selection units (no artboard
 * background): viewBox hugs the union of their bounds. Used by the
 * export dialog's "selection" scope and OS copy-as-SVG.
 */
export function nodesToSvg(
  document: LogoDocument,
  nodeIds: readonly string[],
): string | null {
  const boxes = nodeIds
    .map((id) => paintBounds(document, id))
    .filter((bounds): bounds is NonNullable<typeof bounds> => bounds !== null);
  if (boxes.length === 0) {
    return null;
  }
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const width = Math.max(...boxes.map((b) => b.x + b.width)) - minX;
  const height = Math.max(...boxes.map((b) => b.y + b.height)) - minY;
  if (width <= 0 || height <= 0) {
    return null;
  }

  const defs: string[] = [];
  const body = nodeIds
    .map((nodeId) => renderTree(document, nodeId, defs))
    .filter(Boolean)
    .join("\n  ");
  if (!body) {
    return null;
  }
  const defsBlock = defs.length > 0 ? `\n  <defs>${defs.join("")}</defs>` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}" role="img">${defsBlock}
  ${body}
</svg>`;
}

/**
 * Cap decimal precision of numeric tokens in an SVG string. Only tokens
 * inside quoted attribute values are touched — text content (a wordmark
 * saying "v2.50") passes through verbatim. Integers (including
 * gradient/filter ids) carry no decimal point and are untouched either
 * way, so references can never corrupt.
 */
export function roundSvgNumbers(svg: string, digits: number): string {
  const factor = 10 ** Math.max(0, Math.min(6, Math.round(digits)));
  return svg.replace(/"[^"]*"/g, (attr) =>
    attr.replace(/-?\d*\.\d+(?:e[-+]?\d+)?/gi, (token) => {
      const rounded = Math.round(Number(token) * factor) / factor;
      return Object.is(rounded, -0) ? "0" : String(rounded);
    }),
  );
}

/** Collapse inter-tag whitespace; markup and text content are untouched. */
export function minifySvg(svg: string): string {
  return svg.replace(/>\s+</g, "><").trim();
}

/**
 * Tiny inline-SVG preview of one node (or group subtree) for the layers
 * panel. Rendered from the same tree walk as the real export, so the
 * thumbnail is literally what ships. Hidden layers still get a preview
 * (only the root's visibility is overridden); returns null when the
 * subtree renders to nothing.
 */
export function nodeToPreviewSvg(
  document: LogoDocument,
  nodeId: string,
): string | null {
  const node = document.nodes[nodeId];
  if (!node) {
    return null;
  }
  const bounds = paintBounds(document, nodeId);
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    return null;
  }

  const doc: LogoDocument = node.visible
    ? document
    : {
        ...document,
        nodes: {
          ...document.nodes,
          [nodeId]: { ...node, visible: true } as LogoNode,
        },
      };

  const defs: string[] = [];
  const body = renderTree(doc, nodeId, defs);
  if (!body) {
    return null;
  }

  const pad = Math.max(2, Math.max(bounds.width, bounds.height) * 0.08);
  const defsBlock = defs.length > 0 ? `<defs>${defs.join("")}</defs>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.x - pad} ${
    bounds.y - pad
  } ${bounds.width + pad * 2} ${
    bounds.height + pad * 2
  }" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${defsBlock}${body}</svg>`;
}

export function downloadTextFile(
  contents: string,
  filename: string,
  mimeType: string,
): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadBinaryFile(
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
): void {
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Raster export failure (SVG render, canvas allocation, or encoding). */
export class ExportError extends Data.TaggedError("ExportError")<{
  readonly reason: string;
}> {}

/** Conservative browser limits: 32 MiPx is ~128 MiB before PNG encoding. */
export const MAX_RASTER_DIMENSION = 16_384;
export const MAX_RASTER_PIXELS = 32 * 1024 * 1024;

export type RasterSizeResult =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: string };

/** Validate and round the actual canvas allocation before touching the DOM. */
export function validateRasterSize(
  width: number,
  height: number,
  scale: number,
): RasterSizeResult {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(scale) ||
    width <= 0 ||
    height <= 0 ||
    scale <= 0
  ) {
    return {
      ok: false,
      reason: "Export dimensions must be finite positive numbers.",
    };
  }

  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  if (!Number.isFinite(scaledWidth) || !Number.isFinite(scaledHeight)) {
    return {
      ok: false,
      reason: "Export dimensions must be finite positive numbers.",
    };
  }

  // Positive aspect ratios can round a very thin axis to zero. Canvas
  // allocations cannot be zero-sized, so preserve the ratio as closely as
  // integer pixels allow while guaranteeing one pixel on each axis.
  const pixelWidth = Math.max(1, Math.round(scaledWidth));
  const pixelHeight = Math.max(1, Math.round(scaledHeight));

  if (
    pixelWidth > MAX_RASTER_DIMENSION ||
    pixelHeight > MAX_RASTER_DIMENSION ||
    pixelWidth * pixelHeight > MAX_RASTER_PIXELS
  ) {
    return {
      ok: false,
      reason:
        "Raster export is too large for reliable local export. Keep each side at or below 16,384 px and total area below 32 megapixels.",
    };
  }

  return { ok: true, width: pixelWidth, height: pixelHeight };
}

/**
 * Rasterize an SVG string to a 2D canvas of width×height×scale device
 * pixels. The object URL is an acquired resource: it is revoked on every
 * exit path, including the image failing to load.
 */
export const rasterizeSvg = (
  svg: string,
  width: number,
  height: number,
  scale: number,
  backgroundColor?: string,
): Effect.Effect<HTMLCanvasElement, ExportError> => {
  const size = validateRasterSize(width, height, scale);
  if (!size.ok) {
    return Effect.fail(new ExportError({ reason: size.reason }));
  }

  return Effect.acquireUseRelease(
    Effect.sync(() =>
      URL.createObjectURL(
        new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
      ),
    ),
    (url) =>
      Effect.gen(function* () {
        const image = new Image();
        yield* Effect.async<void, ExportError>((resume) => {
          image.onload = () => resume(Effect.void);
          image.onerror = () =>
            resume(
              Effect.fail(
                new ExportError({ reason: "Unable to render SVG for export." }),
              ),
            );
          image.src = url;
        });

        const canvas = window.document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext("2d");

        if (!context) {
          return yield* Effect.fail(
            new ExportError({ reason: "Canvas is unavailable in this browser." }),
          );
        }

        drawRasterImage(
          context,
          image,
          canvas.width,
          canvas.height,
          backgroundColor,
        );
        return canvas;
      }),
    (url) => Effect.sync(() => URL.revokeObjectURL(url)),
  );
};

export type RasterMimeType = "image/png" | "image/jpeg" | "image/webp";

export type RasterEncodingOptions = {
  mimeType: RasterMimeType;
  /** Browser canvas quality, from 0.1 through 1. Omitted for lossless PNG. */
  quality?: number;
  /** Explicit opaque underlay for JPEG and non-transparent PNG/WebP. */
  backgroundColor?: string;
};

export const MIN_RASTER_QUALITY = 0.1;
export const MAX_RASTER_QUALITY = 1;
const SAFE_RASTER_BACKGROUND = /^#[\da-f]{6}$/i;

function validateRasterEncoding(
  options: RasterEncodingOptions,
  requireBackground: boolean,
): string | null {
  if (
    options.quality !== undefined &&
    (!Number.isFinite(options.quality) ||
      options.quality < MIN_RASTER_QUALITY ||
      options.quality > MAX_RASTER_QUALITY)
  ) {
    return "JPEG and WebP quality must be between 10% and 100%.";
  }
  if (
    options.backgroundColor !== undefined &&
    !SAFE_RASTER_BACKGROUND.test(options.backgroundColor)
  ) {
    return "Raster background must be a six-digit hex color.";
  }
  if (requireBackground && options.backgroundColor === undefined) {
    return "JPEG export requires an explicit background color.";
  }
  return null;
}

/** Draw the background before the source so transparent pixels never turn black. */
export function drawRasterImage(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
  backgroundColor?: string,
): void {
  if (backgroundColor) {
    context.fillStyle = backgroundColor;
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(image, 0, 0, width, height);
}

function rasterFormatLabel(mimeType: RasterMimeType): string {
  if (mimeType === "image/jpeg") {
    return "JPEG";
  }
  if (mimeType === "image/webp") {
    return "WebP";
  }
  return "PNG";
}

/**
 * Encode without a base64 data URL. Browsers may silently fall back to PNG
 * for unsupported encoders, so the returned MIME type is verified.
 */
export const canvasToRasterBlob = (
  canvas: HTMLCanvasElement,
  options: RasterEncodingOptions,
): Effect.Effect<Blob, ExportError> => {
  const validationError = validateRasterEncoding(options, false);
  if (validationError) {
    return Effect.fail(new ExportError({ reason: validationError }));
  }
  return Effect.async<Blob, ExportError>((resume) => {
    canvas.toBlob(
      (blob) => {
        const label = rasterFormatLabel(options.mimeType);
        if (!blob) {
          resume(
            Effect.fail(new ExportError({ reason: `${label} encoding failed.` })),
          );
          return;
        }
        if (blob.type.toLowerCase() !== options.mimeType) {
          resume(
            Effect.fail(
              new ExportError({
                reason: `${label} export is not supported by this browser.`,
              }),
            ),
          );
          return;
        }
        resume(Effect.succeed(blob));
      },
      options.mimeType,
      options.quality,
    );
  });
};

/** Rasterize, encode, and download one PNG/JPEG/WebP file. */
export const downloadRasterFromSvg = (
  svg: string,
  filename: string,
  width: number,
  height: number,
  scale: number,
  options: RasterEncodingOptions,
): Effect.Effect<void, ExportError> => {
  const validationError = validateRasterEncoding(
    options,
    options.mimeType === "image/jpeg",
  );
  if (validationError) {
    return Effect.fail(new ExportError({ reason: validationError }));
  }
  return rasterizeSvg(
    svg,
    width,
    height,
    scale,
    options.backgroundColor,
  ).pipe(
    Effect.flatMap((canvas) => canvasToRasterBlob(canvas, options)),
    Effect.flatMap((blob) =>
      Effect.acquireUseRelease(
        Effect.sync(() => URL.createObjectURL(blob)),
        (url) =>
          Effect.sync(() => {
            const anchor = window.document.createElement("a");
            anchor.href = url;
            anchor.download = filename;
            anchor.click();
          }),
        (url) => Effect.sync(() => URL.revokeObjectURL(url)),
      ),
    ),
  );
};

/** Rasterize an SVG string to a PNG download. */
export const downloadPngFromSvg = (
  svg: string,
  filename: string,
  width: number,
  height: number,
  scale = 2,
): Effect.Effect<void, ExportError> =>
  downloadRasterFromSvg(svg, filename, width, height, scale, {
    mimeType: "image/png",
  });

/** Encode a canvas to PNG bytes. */
const canvasToPngBytes = (
  canvas: HTMLCanvasElement,
): Effect.Effect<Uint8Array, ExportError> =>
  canvasToRasterBlob(canvas, { mimeType: "image/png" }).pipe(
    Effect.flatMap((blob) =>
      Effect.tryPromise({
        try: () => blob.arrayBuffer(),
        catch: () => new ExportError({ reason: "PNG encoding failed." }),
      }),
    ),
    Effect.map((buffer) => new Uint8Array(buffer)),
  );

/** Rasterize an SVG string to encoded PNG bytes. */
export const svgToPngBytes = (
  svg: string,
  width: number,
  height: number,
  scale: number,
): Effect.Effect<Uint8Array, ExportError> =>
  rasterizeSvg(svg, width, height, scale).pipe(
    Effect.flatMap(canvasToPngBytes),
  );

/**
 * Rasterize an SVG onto a transparent SQUARE size×size canvas,
 * contain-fit and centred — the shape .ico entries need regardless of
 * the artboard's aspect ratio.
 */
export const svgToSquarePngBytes = (
  svg: string,
  width: number,
  height: number,
  size: number,
): Effect.Effect<Uint8Array, ExportError> =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      URL.createObjectURL(
        new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
      ),
    ),
    (url) =>
      Effect.gen(function* () {
        const image = new Image();
        yield* Effect.async<void, ExportError>((resume) => {
          image.onload = () => resume(Effect.void);
          image.onerror = () =>
            resume(
              Effect.fail(
                new ExportError({ reason: "Unable to render SVG for export." }),
              ),
            );
          image.src = url;
        });

        const canvas = window.document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) {
          return yield* Effect.fail(
            new ExportError({ reason: "Canvas is unavailable in this browser." }),
          );
        }

        const fit = size / Math.max(width, height);
        const drawWidth = width * fit;
        const drawHeight = height * fit;
        context.drawImage(
          image,
          (size - drawWidth) / 2,
          (size - drawHeight) / 2,
          drawWidth,
          drawHeight,
        );
        return yield* canvasToPngBytes(canvas);
      }),
    (url) => Effect.sync(() => URL.revokeObjectURL(url)),
  );
