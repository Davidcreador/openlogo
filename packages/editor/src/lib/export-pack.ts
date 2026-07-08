import type { LogoDocument, LogoNode, Paint } from "@openlogo/core";
import { getActiveArtboard } from "@openlogo/core";
import { documentStore } from "../state/document";
import { documentToSvg, downloadPngFromSvg, downloadTextFile } from "./export";

/**
 * Production export pack from the active artboard:
 *   {name}.svg           original colours
 *   {name}-mono.svg      single-colour (dark) version
 *   {name}-reversed.svg  white version on transparent background
 *   favicon-16/32/48.png + icon-512.png
 * Sequential downloads; no archive dependency.
 */

function recolorDocument(
  document: LogoDocument,
  color: string,
  background: string,
): LogoDocument {
  const paint: Paint = { type: "solid", color };
  const nodes: Record<string, LogoNode> = {};
  for (const [id, node] of Object.entries(document.nodes)) {
    nodes[id] = {
      ...node,
      fill: paint,
      ...(node.stroke ? { stroke: { ...node.stroke, color } } : {}),
    } as LogoNode;
  }
  return {
    ...document,
    nodes,
    artboards: document.artboards.map((artboard) => ({
      ...artboard,
      background,
    })),
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function exportPack(): Promise<void> {
  const document = documentStore.document;
  const artboard = getActiveArtboard(document);
  const base = artboard.name.toLowerCase().replaceAll(" ", "-");

  const original = documentToSvg(document);
  const mono = documentToSvg(recolorDocument(document, "#111827", "#ffffff"));
  const reversed = documentToSvg(
    recolorDocument(document, "#ffffff", "transparent"),
  );

  downloadTextFile(original, `${base}.svg`, "image/svg+xml");
  await wait(300);
  downloadTextFile(mono, `${base}-mono.svg`, "image/svg+xml");
  await wait(300);
  downloadTextFile(reversed, `${base}-reversed.svg`, "image/svg+xml");

  for (const size of [16, 32, 48]) {
    await wait(300);
    await downloadPngFromSvg(
      original,
      `favicon-${size}.png`,
      artboard.width,
      artboard.height,
      size / Math.max(artboard.width, artboard.height),
    );
  }
  await wait(300);
  await downloadPngFromSvg(
    original,
    "icon-512.png",
    artboard.width,
    artboard.height,
    512 / Math.max(artboard.width, artboard.height),
  );
}
