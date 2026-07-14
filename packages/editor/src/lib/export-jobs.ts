import { Effect } from "effect";
import { type Artboard, type LogoDocument, getActiveArtboard } from "@openlogo/core";
import {
  ExportError,
  MAX_RASTER_QUALITY,
  MIN_RASTER_QUALITY,
  type RasterEncodingOptions,
  type RasterMimeType,
  documentToSvg,
  downloadBinaryFile,
  downloadRasterFromSvg,
  downloadTextFile,
  minifySvg,
  nodesToSvg,
  roundSvgNumbers,
  svgToSquarePngBytes,
  validateRasterSize,
} from "./export";
import { buildIco } from "./ico";
import {
  type TextOutlineError,
  type TextOutlineUnavailableError,
  outlineDocumentTexts,
} from "./text-to-path";
import { type FontEmbedError, embedDocumentFonts } from "./svg-fonts";
import { documentStore } from "../state/document";

export type ExportScope = "active" | "all" | "selection";
export type RasterExportFormat = "png" | "jpeg" | "webp";
export type ExportFormat = "svg" | RasterExportFormat | "ico";
export type RasterScale = 1 | 2 | 3 | "custom";

export const DEFAULT_JPEG_QUALITY = 0.9;
export const DEFAULT_WEBP_QUALITY = 0.85;
export const DEFAULT_RASTER_BACKGROUND = "#ffffff";

type ExportRequestBase = {
  scope: ExportScope;
  /** Selected unit ids; required for the "selection" scope. */
  selectionIds: readonly string[];
};

export type SvgExportSettings = {
  /** Decimal digits kept on attribute numbers (0–6). */
  precision: number;
  minify: boolean;
  /** Convert text to glyph outlines in the exported file only. */
  outlineText: boolean;
};

export type RasterSizeSettings = {
  scale: RasterScale;
  /** Output width in px when scale is "custom". */
  customWidth: number;
};

export type PngExportSettings = RasterSizeSettings & {
  transparentBackground: boolean;
  /** Used behind transparent pixels when transparency is disabled. */
  backgroundColor: string;
};

export type JpegExportSettings = RasterSizeSettings & {
  /** Canvas encoder quality from 0.1 through 1. */
  quality: number;
  /** JPEG is always opaque and always receives this explicit underlay. */
  backgroundColor: string;
};

export type WebpExportSettings = RasterSizeSettings & {
  /** Canvas encoder quality from 0.1 through 1. */
  quality: number;
  transparentBackground: boolean;
  /** Used behind transparent pixels when transparency is disabled. */
  backgroundColor: string;
};

/** Discriminated requests prevent format/settings mismatches at call sites. */
export type ExportRequest =
  | (ExportRequestBase & { format: "svg"; settings: SvgExportSettings })
  | (ExportRequestBase & { format: "png"; settings: PngExportSettings })
  | (ExportRequestBase & { format: "jpeg"; settings: JpegExportSettings })
  | (ExportRequestBase & { format: "webp"; settings: WebpExportSettings })
  | (ExportRequestBase & { format: "ico" });

/** One exportable rendering: an SVG string plus its natural dimensions. */
export type ExportTarget = {
  slug: string;
  svg: string;
  width: number;
  height: number;
};

export type RasterExportPlan = ExportTarget & {
  filename: string;
  scale: number;
  pixelWidth: number;
  pixelHeight: number;
  encoding: RasterEncodingOptions;
};

export type RasterPreflightResult =
  | { ok: true; plans: RasterExportPlan[] }
  | { ok: false; reason: string };

const ICO_SIZES = [16, 32, 48] as const;
const HEX_COLOR = /^#[\da-f]{6}$/i;

export function isRasterFormat(
  format: ExportFormat,
): format is RasterExportFormat {
  return format === "png" || format === "jpeg" || format === "webp";
}

/** Filesystem-safe, deterministic slug with a stable empty-name fallback. */
export function filenameSlug(name: string): string {
  const slug = name
    .replace(/[™®©]/g, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "artboard";
}

/** Board-name slugs, deduped with -2/-3… so N boards give N files. */
export function uniqueSlugs(artboards: readonly Artboard[]): string[] {
  const used = new Set<string>();
  return artboards.map((artboard) => {
    const base = filenameSlug(artboard.name);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  });
}

class ExportSelectionError {
  readonly _tag = "ExportSelectionError";
  readonly reason = "Nothing exportable in the selection.";
}

type BuildError =
  | TextOutlineError
  | TextOutlineUnavailableError
  | ExportSelectionError;

function hasTransparentBackground(request: ExportRequest): boolean {
  return (
    (request.format === "png" || request.format === "webp") &&
    request.settings.transparentBackground
  );
}

function dimensionsFromSvg(svg: string): { width: number; height: number } {
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1];
  const values = viewBox?.trim().split(/[\s,]+/).map(Number);
  const width = values?.[2];
  const height = values?.[3];
  return {
    width: Number.isFinite(width) && width! > 0 ? width! : 1,
    height: Number.isFinite(height) && height! > 0 ? height! : 1,
  };
}

/**
 * Resolve scope to concrete targets. Text outlining happens once on a
 * transient document copy; the live document is never touched.
 */
export const buildExportTargets = (
  sourceDocument: LogoDocument,
  request: ExportRequest,
): Effect.Effect<ExportTarget[], BuildError> =>
  Effect.gen(function* () {
    let document = sourceDocument;
    if (request.format === "svg" && request.settings.outlineText) {
      document = yield* outlineDocumentTexts(document, { failOnSkip: true });
    }

    if (request.scope === "selection") {
      const svg = nodesToSvg(document, request.selectionIds);
      if (!svg) {
        return yield* Effect.fail(new ExportSelectionError());
      }
      const dimensions = dimensionsFromSvg(svg);
      return [{ slug: "selection", svg, ...dimensions }];
    }

    const boards =
      request.scope === "all"
        ? document.artboards
        : [getActiveArtboard(document)];
    const slugs = uniqueSlugs(boards);
    return boards.map((artboard, index) => ({
      slug: slugs[index]!,
      svg: documentToSvg(document, artboard, {
        transparentBackground:
          request.format === "ico" || hasTransparentBackground(request),
      }),
      width: artboard.width,
      height: artboard.height,
    }));
  });

function rasterMimeType(format: RasterExportFormat): RasterMimeType {
  if (format === "jpeg") {
    return "image/jpeg";
  }
  if (format === "webp") {
    return "image/webp";
  }
  return "image/png";
}

function rasterExtension(format: RasterExportFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

function rasterScale(settings: RasterSizeSettings, width: number): number {
  return settings.scale === "custom"
    ? settings.customWidth / width
    : settings.scale;
}

function rasterSuffix(settings: RasterSizeSettings): string {
  if (settings.scale === "custom") {
    return `-${Math.max(1, Math.round(settings.customWidth))}px`;
  }
  return settings.scale > 1 ? `@${settings.scale}x` : "";
}

function lossyQuality(
  format: RasterExportFormat,
  settings: PngExportSettings | JpegExportSettings | WebpExportSettings,
): number | undefined {
  return format === "png" || !("quality" in settings)
    ? undefined
    : settings.quality;
}

function backgroundColor(
  format: RasterExportFormat,
  settings: PngExportSettings | JpegExportSettings | WebpExportSettings,
): string | undefined {
  const transparent =
    (format === "png" || format === "webp") &&
    "transparentBackground" in settings &&
    settings.transparentBackground;
  if (transparent) {
    return undefined;
  }
  return typeof settings.backgroundColor === "string"
    ? settings.backgroundColor.toLowerCase()
    : "";
}

function validateRasterSettings(
  format: RasterExportFormat,
  settings: PngExportSettings | JpegExportSettings | WebpExportSettings,
): string | null {
  if (
    settings.scale !== "custom" &&
    settings.scale !== 1 &&
    settings.scale !== 2 &&
    settings.scale !== 3
  ) {
    return "Raster scale must be 1×, 2×, 3×, or a custom width.";
  }
  if (
    settings.scale === "custom" &&
    (!Number.isFinite(settings.customWidth) || settings.customWidth < 1)
  ) {
    return "Custom raster width must be a finite positive number.";
  }

  const quality = lossyQuality(format, settings);
  if (
    quality !== undefined &&
    (!Number.isFinite(quality) ||
      quality < MIN_RASTER_QUALITY ||
      quality > MAX_RASTER_QUALITY)
  ) {
    return "JPEG and WebP quality must be between 10% and 100%.";
  }

  const background = backgroundColor(format, settings);
  if (background !== undefined && !HEX_COLOR.test(background)) {
    return "Raster background must be a six-digit hex color.";
  }
  // JPEG cannot represent transparency. Its discriminated settings have no
  // transparency flag, and this runtime check guarantees an explicit underlay.
  if (format === "jpeg" && background === undefined) {
    return "JPEG export requires an explicit background color.";
  }
  return null;
}

/**
 * Validate every target before allocating any canvas. A failed batch returns
 * no partial plans, preventing half-finished multi-board exports.
 */
export function preflightRasterTargets(
  targets: readonly ExportTarget[],
  request:
    | Extract<ExportRequest, { format: "png" }>
    | Extract<ExportRequest, { format: "jpeg" }>
    | Extract<ExportRequest, { format: "webp" }>,
): RasterPreflightResult {
  const settingsError = validateRasterSettings(request.format, request.settings);
  if (settingsError) {
    return { ok: false, reason: settingsError };
  }

  const plans: RasterExportPlan[] = [];
  for (const target of targets) {
    const scale = rasterScale(request.settings, target.width);
    const size = validateRasterSize(target.width, target.height, scale);
    if (!size.ok) {
      return { ok: false, reason: size.reason };
    }
    const quality = lossyQuality(request.format, request.settings);
    const background = backgroundColor(request.format, request.settings);
    plans.push({
      ...target,
      filename: `${target.slug}${rasterSuffix(request.settings)}.${rasterExtension(
        request.format,
      )}`,
      scale,
      pixelWidth: size.width,
      pixelHeight: size.height,
      encoding: {
        mimeType: rasterMimeType(request.format),
        ...(quality === undefined ? {} : { quality }),
        ...(background === undefined ? {} : { backgroundColor: background }),
      },
    });
  }
  return { ok: true, plans };
}

/**
 * Run one export request. Multi-file downloads are paced so browsers do not
 * coalesce a burst; raster batches are fully preflighted before the first IO.
 */
export const runExport = (
  request: ExportRequest,
): Effect.Effect<number, BuildError | ExportError | FontEmbedError> =>
  Effect.gen(function* () {
    const sourceDocument = documentStore.committedDocument;
    let targets = yield* buildExportTargets(sourceDocument, request);
    if (request.format !== "svg") {
      targets = yield* Effect.all(
        targets.map((target) =>
          embedDocumentFonts(target.svg, sourceDocument).pipe(
            Effect.map((svg) => ({ ...target, svg })),
          ),
        ),
        { concurrency: 2 },
      );
    }

    if (
      request.format === "png" ||
      request.format === "jpeg" ||
      request.format === "webp"
    ) {
      const preflight = preflightRasterTargets(targets, request);
      if (!preflight.ok) {
        return yield* Effect.fail(new ExportError({ reason: preflight.reason }));
      }

      let first = true;
      for (const plan of preflight.plans) {
        if (!first) {
          yield* Effect.sleep("300 millis");
        }
        first = false;
        yield* downloadRasterFromSvg(
          plan.svg,
          plan.filename,
          plan.width,
          plan.height,
          plan.scale,
          plan.encoding,
        );
      }
      return preflight.plans.length;
    }

    let first = true;
    for (const target of targets) {
      if (!first) {
        yield* Effect.sleep("300 millis");
      }
      first = false;

      if (request.format === "svg") {
        let svg = roundSvgNumbers(target.svg, request.settings.precision);
        if (request.settings.minify) {
          svg = minifySvg(svg);
        }
        yield* Effect.sync(() =>
          downloadTextFile(svg, `${target.slug}.svg`, "image/svg+xml"),
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
