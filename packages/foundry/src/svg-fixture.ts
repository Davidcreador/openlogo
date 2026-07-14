import type { LogoDocument, LogoNode, PathNode, TextNode } from "@openlogo/core";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function paint(node: LogoNode): string {
  const fill = node.fill.type === "solid" ? node.fill.color : "#999999";
  const stroke = node.stroke
    ? ` stroke="${escapeXml(node.stroke.color)}" stroke-width="${node.stroke.width}"`
    : "";
  return `fill="${escapeXml(fill)}"${stroke}`;
}

function rotation(node: LogoNode): string {
  return node.rotation === 0
    ? ""
    : ` transform="rotate(${node.rotation} ${node.x + node.width / 2} ${node.y + node.height / 2})"`;
}

function pathElement(node: PathNode): string {
  const sx = node.width / node.intrinsicWidth;
  const sy = node.height / node.intrinsicHeight;
  return `<path id="${escapeXml(node.id)}" d="${escapeXml(node.d)}" ${paint(node)} transform="translate(${node.x} ${node.y}) scale(${sx} ${sy})"/>`;
}

function textElement(node: TextNode): string {
  const style = `font-family:${escapeXml(node.fontFamily)};font-size:${node.fontSize}px;font-weight:${node.fontWeight};font-style:${node.fontStyle ?? "normal"};letter-spacing:${node.letterSpacing}px`;
  if (node.onPath) {
    return `<text fill="${escapeXml(node.fill.type === "solid" ? node.fill.color : "#999999")}" style="${style}"><textPath href="#${escapeXml(node.onPath.pathId)}" startOffset="${node.onPath.startOffset}">${escapeXml(node.content)}</textPath></text>`;
  }
  const x = node.align === "center" ? node.x + node.width / 2 : node.align === "right" ? node.x + node.width : node.x;
  const anchor = node.align === "center" ? "middle" : node.align === "right" ? "end" : "start";
  return `<text x="${x}" y="${node.y + node.fontSize}" fill="${escapeXml(node.fill.type === "solid" ? node.fill.color : "#999999")}" text-anchor="${anchor}" style="${style}"${rotation(node)}>${escapeXml(node.content)}</text>`;
}

function nodeElement(node: LogoNode): string {
  switch (node.type) {
    case "rectangle":
      return `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${node.cornerRadius}" ${paint(node)}${rotation(node)}/>`;
    case "ellipse":
      return `<ellipse cx="${node.x + node.width / 2}" cy="${node.y + node.height / 2}" rx="${node.width / 2}" ry="${node.height / 2}" ${paint(node)}${rotation(node)}/>`;
    case "path":
      return pathElement(node);
    case "text":
      return textElement(node);
    case "group":
      return "";
  }
}

export function renderShowcaseSvg(documents: readonly LogoDocument[]): string {
  const gap = 32;
  const margin = 24;
  const columns = 2;
  const cellWidth = Math.max(...documents.map((document) => document.artboards[0]!.width));
  const rows = Math.ceil(documents.length / columns);
  const rowHeights = Array.from({ length: rows }, (_, row) =>
    Math.max(
      ...documents
        .slice(row * columns, row * columns + columns)
        .map((document) => document.artboards[0]!.height),
    ),
  );
  const width = cellWidth * columns + gap * (columns - 1) + margin * 2;
  const height = rowHeights.reduce((sum, value) => sum + value, 0) + gap * (rows - 1) + margin * 2;
  const sections: string[] = [];

  for (const [index, document] of documents.entries()) {
    const artboard = document.artboards[0]!;
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = margin + column * (cellWidth + gap) + (cellWidth - artboard.width) / 2;
    const y = margin + rowHeights.slice(0, row).reduce((sum, value) => sum + value + gap, 0);
    const attachedPathIds = new Set(
      Object.values(document.nodes)
        .filter((node): node is TextNode => node.type === "text" && node.onPath !== undefined)
        .map((node) => node.onPath!.pathId),
    );
    const definitions = [...attachedPathIds]
      .map((id) => document.nodes[id])
      .filter((node): node is PathNode => node?.type === "path")
      .map(pathElement)
      .join("");
    const content = artboard.nodeIds
      .map((id) => document.nodes[id])
      .filter((node): node is LogoNode => node !== undefined && node.visible)
      .map(nodeElement)
      .join("\n");
    sections.push(
      `<g transform="translate(${x} ${y})"><title>${escapeXml(document.name)}</title><rect width="${artboard.width}" height="${artboard.height}" fill="${escapeXml(artboard.background)}"/><defs>${definitions}</defs>${content}</g>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n${sections.join("\n")}\n</svg>\n`;
}
