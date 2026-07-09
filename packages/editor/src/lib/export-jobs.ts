import { Effect } from "effect";
import { type Artboard, type LogoDocument, getActiveArtboard } from "@openlogo/core";
import {
  type ExportError,
  documentToSvg,
  downloadBinaryFile,
  downloadPngFromSvg,
  downloadTextFile,
  minifySvg,
  nodesToSvg,
  roundSvgNumbers,
  svgToSquarePngBytes,
} from "./export";
import { buildIco } from "./ico";
import { type TextOutlineError, outlineDocumentTexts } from "./text-to-path";
import { documentStore } from "../state/document";

export type ExportScope = "active" | "all" | "selection";
export type ExportFormat = "svg" | "png" | "ico";

export type ExportRequest = {
  scope: ExportScope;
  format: ExportFormat;
  /** Selected unit ids; required for the "selection" scope. */
  selectionIds: readonly string[];
  svg: {
    /** Decimal digits kept on attribute numbers (0–6). */
    precision: number;
    minify: boolean;
    /** Convert text to glyph outlines in the exported file only. */
    outlineText: boolean;
  };
  png: {
    /** 1 | 2 | 3, or "custom". */
    scale: number | "custom";
    /** Output width in px when scale is "custom". */
    customWidth: number;
    transparentBackground: boolean;
  };
};

/** One exportable rendering: an SVG string plus its natural dimensions. */
type ExportTarget = {
  slug: string;
  svg: string;
  width: number;
  height: number;
};

const ICO_SIZES = [16, 32, 48] as const;

function slugify(name: string): string {
  return name.toLowerCase().replaceAll(" ", "-");
}

/** Board-name slugs, deduped with -2/-3… so N boards give N files. */
function uniqueSlugs(artboards: readonly Artboard[]): string[] {
  const seen = new Map<string, number>();
  return artboards.map((artboard) => {
    const base = slugify(artboard.name);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

export class ExportSelectionError {
  readonly _tag = "ExportSelectionError";
  readonly reason = "Nothing exportable in the selection.";
}

type BuildError = TextOutlineError | ExportSelectionError;

/**
 * Resolve the request's scope to concrete SVG targets. Text outlining
 * happens ONCE here on a transient document copy — the live document is
 * never touched.
 */
const buildTargets = (
  request: ExportRequest,
): Effect.Effect<ExportTarget[], BuildError> =>
  Effect.gen(function* () {
    let document: LogoDocument = documentStore.document;
    if (request.format === "svg" && request.svg.outlineText) {
      document = yield* outlineDocumentTexts(document);
    }

    const transparent =
      request.format !== "svg" && request.png.transparentBackground;

    if (request.scope === "selection") {
      const svg = nodesToSvg(document, request.selectionIds);
      if (!svg) {
        return yield* Effect.fail(new ExportSelectionError());
      }
      const dims = svg.match(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/);
      return [
        {
          slug: "selection",
          svg,
          width: Number(dims?.[1] ?? 0) || 1,
          height: Number(dims?.[2] ?? 0) || 1,
        },
      ];
    }

    const boards =
      request.scope === "all"
        ? document.artboards
        : [getActiveArtboard(document)];
    const slugs = uniqueSlugs(boards);
    return boards.map((artboard, index) => ({
      slug: slugs[index]!,
      svg: documentToSvg(document, artboard, {
        transparentBackground: transparent,
      }),
      width: artboard.width,
      height: artboard.height,
    }));
  });

/**
 * Run an export request: one download per target, paced 300ms apart so
 * browsers don't coalesce/block the burst (same trick as export-pack).
 */
export const runExport = (
  request: ExportRequest,
): Effect.Effect<number, BuildError | ExportError> =>
  Effect.gen(function* () {
    const targets = yield* buildTargets(request);

    let first = true;
    for (const target of targets) {
      if (!first) {
        yield* Effect.sleep("300 millis");
      }
      first = false;

      if (request.format === "svg") {
        let svg = roundSvgNumbers(target.svg, request.svg.precision);
        if (request.svg.minify) {
          svg = minifySvg(svg);
        }
        yield* Effect.sync(() =>
          downloadTextFile(svg, `${target.slug}.svg`, "image/svg+xml"),
        );
      } else if (request.format === "png") {
        const scale =
          request.png.scale === "custom"
            ? Math.max(1, request.png.customWidth) / target.width
            : request.png.scale;
        const suffix =
          request.png.scale === "custom"
            ? `-${Math.max(1, Math.round(request.png.customWidth))}px`
            : request.png.scale > 1
              ? `@${request.png.scale}x`
              : "";
        yield* downloadPngFromSvg(
          target.svg,
          `${target.slug}${suffix}.png`,
          target.width,
          target.height,
          scale,
        );
      } else {
        // True multi-image .ico: square PNG entry per size, one file.
        const entries = yield* Effect.all(
          ICO_SIZES.map((size) =>
            svgToSquarePngBytes(
              target.svg,
              target.width,
              target.height,
              size,
            ).pipe(Effect.map((png) => ({ size, png }))),
          ),
        );
        yield* Effect.sync(() =>
          downloadBinaryFile(
            buildIco(entries),
            `${target.slug}.ico`,
            "image/x-icon",
          ),
        );
      }
    }

    return targets.length;
  });
