import {
  getActiveArtboard,
  type Artboard,
  type LogoDocument,
} from "@openlogo/core";
import { Effect } from "effect";
import { documentToSvg, svgToPngBytes } from "./export";
import { embedDocumentFonts } from "./svg-fonts";

export const DOCUMENT_THUMBNAIL_LONGEST_EDGE = 320;

export type DocumentThumbnailDependencies = {
  renderArtboard(document: LogoDocument, artboard: Artboard): string;
  embedFonts(svg: string, document: LogoDocument): Promise<string>;
  rasterizePng(
    svg: string,
    width: number,
    height: number,
    scale: number,
  ): Promise<Uint8Array>;
};

const DEFAULT_DEPENDENCIES: DocumentThumbnailDependencies = {
  renderArtboard: (document, artboard) => documentToSvg(document, artboard),
  embedFonts: (svg, document) =>
    Effect.runPromise(embedDocumentFonts(svg, document)),
  rasterizePng: (svg, width, height, scale) =>
    Effect.runPromise(svgToPngBytes(svg, width, height, scale)),
};

/** Render the active artboard without requiring the mounted editor renderer. */
export async function renderDocumentThumbnail(
  document: LogoDocument,
  dependencies: DocumentThumbnailDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  const artboard = getActiveArtboard(document);
  const scale =
    DOCUMENT_THUMBNAIL_LONGEST_EDGE /
    Math.max(artboard.width, artboard.height);
  const svg = dependencies.renderArtboard(document, artboard);
  const embedded = await dependencies.embedFonts(svg, document);
  const png = await dependencies.rasterizePng(
    embedded,
    artboard.width,
    artboard.height,
    scale,
  );
  return pngDataUrl(png);
}

function pngDataUrl(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return `data:image/png;base64,${btoa(binary)}`;
}
