import {
  type Artboard,
  type LogoDocument,
  type LogoNode,
  type Paint,
  getActiveArtboard,
} from "@openlogo/core";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

let gradientCounter = 0;

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

function renderNode(node: LogoNode, defs: string[]): string {
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
  const base = `opacity="${node.opacity}" fill="${fill}"${stroke}${blend}${rotate}`;

  if (node.type === "rectangle") {
    return `<rect ${base} x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${node.cornerRadius}" />`;
  }

  if (node.type === "ellipse") {
    return `<ellipse ${base} cx="${node.x + node.width / 2}" cy="${
      node.y + node.height / 2
    }" rx="${node.width / 2}" ry="${node.height / 2}" />`;
  }

  if (node.type === "text") {
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

  return `<g opacity="${node.opacity}" fill="${fill}"${stroke} transform="${pathRotate}${transform}"><path d="${escapeXml(
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
    return `<g${opacity}${blend} data-name="${escapeXml(node.name)}">\n  ${inner}\n  </g>`;
  }

  return renderNode(node, defs);
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

export async function downloadPngFromSvg(
  svg: string,
  filename: string,
  width: number,
  height: number,
  scale = 2,
): Promise<void> {
  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  const image = new Image();

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Unable to render SVG for export."));
    image.src = url;
  });

  const canvas = window.document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");

  if (!context) {
    URL.revokeObjectURL(url);
    throw new Error("Canvas is unavailable in this browser.");
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);

  const anchor = window.document.createElement("a");
  anchor.href = canvas.toDataURL("image/png");
  anchor.download = filename;
  anchor.click();
}
