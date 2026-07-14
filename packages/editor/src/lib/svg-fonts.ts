import { Data, Effect } from "effect";
import type { LogoDocument } from "@openlogo/core";
import {
  type FontStyleName,
  catalogEntry,
  fontCatalog,
  nearestStyle,
  nearestWeight,
} from "./font-catalog";
import { fontStore } from "./font-store";

export type SvgFontFace = {
  family: string;
  weight: number;
  style: FontStyleName;
  bytes: ArrayBuffer;
};

export type SvgFontRequest = Omit<SvgFontFace, "bytes"> & {
  sourceFamily: string;
};

export class FontEmbedError extends Data.TaggedError("FontEmbedError")<{
  readonly reason: string;
  readonly family: string;
}> {}

/** Resolve and deduplicate the exact catalog faces used by text nodes. */
export function collectDocumentFontFaces(
  document: LogoDocument,
): SvgFontRequest[] {
  const faces = new Map<string, SvgFontRequest>();
  for (const node of Object.values(document.nodes)) {
    if (node.type !== "text" || node.content.length === 0) {
      continue;
    }
    const family = catalogEntry(node.fontFamily) ?? catalogEntry("Inter")!;
    const weight = nearestWeight(family, node.fontWeight);
    const style = nearestStyle(family, node.fontStyle ?? "normal");
    const cssFamily = catalogEntry(node.fontFamily)
      ? family.name
      : node.fontFamily;
    const key = `${cssFamily}\u0000${weight}\u0000${style}`;
    faces.set(key, {
      family: cssFamily,
      sourceFamily: family.name,
      weight,
      style,
    });
  }
  return [...faces.values()];
}

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Avoid spreading a full font buffer onto the JavaScript call stack.
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

function cssString(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("<", "\\3c ")
    .replaceAll(">", "\\3e ")}"`;
}

/**
 * Add self-contained TTF faces to an SVG. This is kept pure so export tests
 * can verify the exact payload without fetching fonts.
 */
export function embedSvgFontFaces(svg: string, faces: readonly SvgFontFace[]): string {
  if (faces.length === 0) {
    return svg;
  }
  const rules = faces
    .map(
      (face) =>
        `@font-face{font-family:${cssString(face.family)};font-style:${face.style};font-weight:${face.weight};src:url(data:font/ttf;base64,${bytesToBase64(face.bytes)}) format("truetype")}`,
    )
    .join("");
  const style = `<style type="text/css">${rules}</style>`;
  if (svg.includes("<defs>")) {
    return svg.replace("<defs>", `<defs>${style}`);
  }
  return svg.replace(/(<svg\b[^>]*>)/, `$1<defs>${style}</defs>`);
}

/**
 * Fetch every face needed by the document, then make the SVG deterministic
 * for browser rasterization. A missing face fails explicitly rather than
 * silently substituting a system font.
 */
export const embedDocumentFonts = (
  svg: string,
  document: LogoDocument,
): Effect.Effect<string, FontEmbedError> =>
  Effect.gen(function* () {
    yield* fontCatalog.init();
    const requests = collectDocumentFontFaces(document);
    const faces: SvgFontFace[] = [];
    for (const request of requests) {
      const bytes = yield* fontStore.ensureEffect(
        request.sourceFamily,
        request.weight,
        request.style,
      );
      if (!bytes) {
        return yield* Effect.fail(
          new FontEmbedError({
            family: request.sourceFamily,
            reason: `Could not load “${request.sourceFamily}” for raster export. Check the connection and try again.`,
          }),
        );
      }
      faces.push({
        family: request.family,
        weight: request.weight,
        style: request.style,
        bytes,
      });
    }
    return embedSvgFontFaces(svg, faces);
  });
