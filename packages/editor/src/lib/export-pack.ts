import { Effect } from "effect";
import type { LogoDocument, LogoNode, Paint } from "@openlogo/core";
import { getActiveArtboard } from "@openlogo/core";
import { documentStore } from "../state/document";
import {
  type ExportError,
  documentToSvg,
  downloadPngFromSvg,
  downloadTextFile,
} from "./export";
import { type FontEmbedError, embedDocumentFonts } from "./svg-fonts";

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

export const exportPack: Effect.Effect<void, ExportError | FontEmbedError> = Effect.gen(
  function* () {
    const document = documentStore.committedDocument;
    const artboard = getActiveArtboard(document);
    const base = artboard.name.toLowerCase().replaceAll(" ", "-");

    const original = documentToSvg(document);
    const mono = documentToSvg(recolorDocument(document, "#111827", "#ffffff"));
    const reversed = documentToSvg(
      recolorDocument(document, "#ffffff", "transparent"),
    );
    const rasterOriginal = yield* embedDocumentFonts(original, document);

    // The pauses keep browsers from coalescing/blocking rapid downloads.
    yield* Effect.sync(() =>
      downloadTextFile(original, `${base}.svg`, "image/svg+xml"),
    );
    yield* Effect.sleep("300 millis");
    yield* Effect.sync(() =>
      downloadTextFile(mono, `${base}-mono.svg`, "image/svg+xml"),
    );
    yield* Effect.sleep("300 millis");
    yield* Effect.sync(() =>
      downloadTextFile(reversed, `${base}-reversed.svg`, "image/svg+xml"),
    );

    for (const size of [16, 32, 48]) {
      yield* Effect.sleep("300 millis");
      yield* downloadPngFromSvg(
        rasterOriginal,
        `favicon-${size}.png`,
        artboard.width,
        artboard.height,
        size / Math.max(artboard.width, artboard.height),
      );
    }
    yield* Effect.sleep("300 millis");
    yield* downloadPngFromSvg(
      rasterOriginal,
      "icon-512.png",
      artboard.width,
      artboard.height,
      512 / Math.max(artboard.width, artboard.height),
    );
  },
);
