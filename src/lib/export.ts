import {
  type Artboard,
  type LogoDocument,
  type LogoNode,
  getActiveArtboard,
  getNodesForArtboard,
} from "./document";

const pathCoordinateSize = 96;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderNode(node: LogoNode): string {
  const transform =
    node.rotation === 0
      ? ""
      : ` transform="rotate(${node.rotation} ${node.x + node.width / 2} ${
          node.y + node.height / 2
        })"`;
  const baseAttrs = `id="${escapeXml(node.id)}" opacity="${node.opacity}" fill="${
    node.fill.value
  }"${node.stroke ? ` stroke="${node.stroke.color}" stroke-width="${node.stroke.width}"` : ""}${transform}`;

  if (node.type === "rectangle") {
    return `<rect ${baseAttrs} x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${node.cornerRadius ?? 0}" />`;
  }

  if (node.type === "ellipse") {
    return `<ellipse ${baseAttrs} cx="${node.x + node.width / 2}" cy="${
      node.y + node.height / 2
    }" rx="${node.width / 2}" ry="${node.height / 2}" />`;
  }

  if (node.type === "text") {
    return `<text ${baseAttrs} x="${node.x}" y="${node.y + node.fontSize}" font-family="${escapeXml(
      node.fontFamily,
    )}" font-size="${node.fontSize}" font-weight="${node.fontWeight}" letter-spacing="${
      node.letterSpacing
    }">${escapeXml(node.content)}</text>`;
  }

  if (node.type === "path") {
    const transform = `translate(${node.x + node.width / 2} ${
      node.y + node.height / 2
    }) rotate(${node.rotation}) scale(${node.width / pathCoordinateSize} ${
      node.height / pathCoordinateSize
    }) translate(${-pathCoordinateSize / 2} ${-pathCoordinateSize / 2})`;

    return `<g id="${escapeXml(node.id)}" opacity="${node.opacity}" fill="${
      node.fill.value
    }"${node.stroke ? ` stroke="${node.stroke.color}" stroke-width="${node.stroke.width}"` : ""} transform="${transform}">
    <path d="${escapeXml(
      node.d,
    )}" vector-effect="non-scaling-stroke" />
  </g>`;
  }

  return "";
}

export function documentToSvg(
  document: LogoDocument,
  artboard: Artboard = getActiveArtboard(document),
): string {
  const nodes = getNodesForArtboard(document, artboard.id).filter(
    (node) => node.visible,
  );
  const body = nodes.map(renderNode).join("\n  ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${artboard.width}" height="${artboard.height}" viewBox="0 0 ${artboard.width} ${artboard.height}" role="img" aria-label="${escapeXml(
    artboard.name,
  )}">
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
  const anchor = document.createElement("a");
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
    image.onerror = () => reject(new Error("Unable to render SVG preview."));
    image.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");

  if (!context) {
    URL.revokeObjectURL(url);
    throw new Error("Canvas is unavailable in this browser.");
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);

  const pngUrl = canvas.toDataURL("image/png");
  const anchor = document.createElement("a");
  anchor.href = pngUrl;
  anchor.download = filename;
  anchor.click();
}
