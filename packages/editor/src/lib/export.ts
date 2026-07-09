import { Data, Effect } from "effect";
import {
  type Artboard,
  type LogoDocument,
  type LogoNode,
  type Paint,
  type PathNode,
  type TextNode,
  getActiveArtboard,
  pathGeometryToSvg,
  reversePathGeometry,
  unitBounds,
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
      }" flood-color="${effect.color}" flood-opacity="${effect.opacity}" /></filter>`,
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
        `<feFlood flood-color="${effect.color}" flood-opacity="${effect.opacity}" result="c${step}" />`,
        `<feComposite in="c${step}" in2="o${step}" operator="in" result="u${step}" />`,
      );
      under.push(`u${step}`);
    } else if (effect.type === "outline") {
      if (effect.width <= 0) {
        continue;
      }
      primitives.push(
        `<feMorphology in="SourceAlpha" operator="dilate" radius="${effect.width}" result="m${step}" />`,
        `<feFlood flood-color="${effect.color}" flood-opacity="${effect.opacity}" result="c${step}" />`,
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
  }" font-weight="${node.fontWeight}" letter-spacing="${
    node.letterSpacing
  }"><textPath href="#${id}"${side} startOffset="${
    attachment.startOffset
  }">${escapeXml(node.content)}</textPath></text>`;
}

function paintAttr(paint: Paint, defs: string[]): string {
  if (paint.type === "solid") {
    return paint.color;
  }

  gradientCounter += 1;
  const id = `grad-${gradientCounter}`;
  const radians = (paint.angle * Math.PI) / 180;
  const x2 = 50 + Math.cos(radians) * 50;
  const y2 = 50 + Math.sin(radians) * 50;
  const stops = paint.stops
    .map(
      (stop) =>
        `<stop offset="${stop.offset}" stop-color="${stop.color}" />`,
    )
    .join("");
  defs.push(
    `<linearGradient id="${id}" x1="${100 - x2}%" y1="${100 - y2}%" x2="${x2}%" y2="${y2}%">${stops}</linearGradient>`,
  );
  return `url(#${id})`;
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
  const fill = paintAttr(node.fill, defs);
  const stroke = node.stroke
    ? ` stroke="${node.stroke.color}" stroke-width="${node.stroke.width}"`
    : "";
  const blend = node.blendMode
    ? ` style="mix-blend-mode:${node.blendMode}"`
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

    return `<text ${base}${anchor} x="${anchorX}" y="${
      node.y + node.fontSize
    }" font-family="${escapeXml(node.fontFamily)}" font-size="${
      node.fontSize
    }" font-weight="${node.fontWeight}" letter-spacing="${
      node.letterSpacing
    }">${escapeXml(node.content)}</text>`;
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

  return `<g opacity="${node.opacity}" fill="${fill}"${stroke}${filter} transform="${pathRotate}${transform}"><path d="${escapeXml(
    node.d,
  )}" /></g>`;
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
    const inner = node.children
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
    return `<g${opacity}${blend}${filter} data-name="${escapeXml(node.name)}">\n  ${inner}\n  </g>`;
  }

  return renderNode(document, node, defs);
}

export function documentToSvg(
  document: LogoDocument,
  artboard: Artboard = getActiveArtboard(document),
): string {
  const defs: string[] = [];
  const body = artboard.nodeIds
    .map((nodeId) => renderTree(document, nodeId, defs))
    .filter(Boolean)
    .join("\n  ");
  const defsBlock = defs.length > 0 ? `\n  <defs>${defs.join("")}</defs>` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${artboard.width}" height="${artboard.height}" viewBox="0 0 ${artboard.width} ${artboard.height}" role="img" aria-label="${escapeXml(
    artboard.name,
  )}">${defsBlock}
  <rect width="100%" height="100%" fill="${artboard.background}" />
  ${body}
</svg>`;
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
  const bounds = unitBounds(document, nodeId);
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

/** PNG rasterization failure (SVG didn't render, or no 2D canvas). */
export class ExportError extends Data.TaggedError("ExportError")<{
  readonly reason: string;
}> {}

/**
 * Rasterize an SVG string to a PNG download. The object URL is an acquired
 * resource: it is revoked on every exit path, including the image failing
 * to load (which previously leaked it).
 */
export const downloadPngFromSvg = (
  svg: string,
  filename: string,
  width: number,
  height: number,
  scale = 2,
): Effect.Effect<void, ExportError> =>
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
        canvas.width = width * scale;
        canvas.height = height * scale;
        const context = canvas.getContext("2d");

        if (!context) {
          return yield* Effect.fail(
            new ExportError({ reason: "Canvas is unavailable in this browser." }),
          );
        }

        context.drawImage(image, 0, 0, canvas.width, canvas.height);

        const anchor = window.document.createElement("a");
        anchor.href = canvas.toDataURL("image/png");
        anchor.download = filename;
        anchor.click();
      }),
    (url) => Effect.sync(() => URL.revokeObjectURL(url)),
  );
