import { useRef, useState } from "react";
import { Effect } from "effect";
import { getActiveArtboard } from "@openlogo/core";
import { exportPack } from "../lib/export-pack";
import {
  MAX_RASTER_DIMENSION,
  documentToSvg,
  nodesToSvg,
} from "../lib/export";
import {
  DEFAULT_JPEG_QUALITY,
  DEFAULT_RASTER_BACKGROUND,
  DEFAULT_WEBP_QUALITY,
  type ExportFormat,
  type ExportRequest,
  type ExportScope,
  type RasterScale,
  isRasterFormat,
  runExport,
} from "../lib/export-jobs";
import { documentStore, useDocument } from "../state/document";
import { useEditorStore } from "../state/editor-store";
import { useModalDialog } from "../lib/use-modal-dialog";

const FIELD =
  "h-28 w-72 rounded-field border border-field-border bg-field px-8 text-[12.5px] tabular-nums text-ink outline-none transition-[border-color,box-shadow] duration-140 ease-studio focus:border-accent focus:bg-card focus:shadow-ring";
const TAB_BASE =
  "flex-1 rounded-[6px] py-5 text-[12px] transition-[background-color,color,box-shadow] duration-120 ease-studio disabled:cursor-default disabled:opacity-35";
const TAB_ON =
  "bg-card font-semibold text-ink shadow-tab";
const BUTTON =
  "rounded-field border border-field-border bg-card px-12 py-6 text-[12px] text-ink transition-[border-color,color] duration-140 ease-studio hover:enabled:border-accent hover:enabled:text-accent disabled:cursor-not-allowed disabled:opacity-45";
const PRIMARY =
  "rounded-field bg-linear-to-b from-accent-grad to-accent px-12 py-6 text-[12px] font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.2)] transition-[filter,box-shadow] duration-140 ease-studio hover:enabled:brightness-[1.08] hover:enabled:shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_2px_10px_var(--glow-40)] disabled:cursor-not-allowed disabled:opacity-45";
const ROW = "flex items-center justify-between gap-8 text-[12px] text-ink-dim";
const CHECK = "flex items-center gap-6 text-[12px] text-ink-dim";

const SCOPES: Array<{ id: ExportScope; label: string }> = [
  { id: "active", label: "Active board" },
  { id: "all", label: "All boards" },
  { id: "selection", label: "Selection" },
];

const FORMATS: Array<{ id: ExportFormat; label: string }> = [
  { id: "svg", label: "SVG" },
  { id: "png", label: "PNG" },
  { id: "jpeg", label: "JPEG" },
  { id: "webp", label: "WebP" },
  { id: "ico", label: "ICO" },
];

const EXPORT_DIALOG_TITLE_ID = "export-dialog-title";
const CUSTOM_WIDTH_ERROR_ID = "export-custom-width-error";
const QUALITY_ERROR_ID = "export-quality-error";

/**
 * Export dialog: scope (active / all boards / selection) × format (SVG
 * with precision/minify/outline-text, safe PNG/JPEG/WebP raster settings,
 * and true multi-image .ico). Filenames come from board names; the quick
 * export pack lives here too.
 */
export function ExportDialog() {
  const open = useEditorStore((state) => state.exportDialogOpen);
  const setOpen = useEditorStore((state) => state.setExportDialogOpen);
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const setToast = useEditorStore((state) => state.setToast);
  const document = useDocument();

  const [scope, setScope] = useState<ExportScope>("active");
  const [format, setFormat] = useState<ExportFormat>("svg");
  const [precision, setPrecision] = useState("2");
  const [minify, setMinify] = useState(false);
  const [outlineText, setOutlineText] = useState(false);
  const [rasterScale, setRasterScale] = useState<RasterScale>(2);
  const [customWidth, setCustomWidth] = useState("1024");
  const [transparent, setTransparent] = useState(false);
  const [backgroundColor, setBackgroundColor] = useState(
    DEFAULT_RASTER_BACKGROUND,
  );
  const [jpegQuality, setJpegQuality] = useState(
    String(DEFAULT_JPEG_QUALITY * 100),
  );
  const [webpQuality, setWebpQuality] = useState(
    String(DEFAULT_WEBP_QUALITY * 100),
  );
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useModalDialog({
    open,
    onClose: () => setOpen(false),
    dialogRef,
    fallbackFocusSelector: "[data-export-dialog-trigger]",
  });

  if (!open) {
    return null;
  }

  const hasSelection = selectedNodeIds.length > 0;
  const effectiveScope =
    scope === "selection" && !hasSelection ? "active" : scope;
  const fileCount =
    effectiveScope === "all" ? document.artboards.length : 1;
  const customWidthNumber = Number(customWidth);
  const customWidthValid =
    Number.isFinite(customWidthNumber) &&
    customWidthNumber >= 1 &&
    customWidthNumber <= MAX_RASTER_DIMENSION;
  const rasterFormat = isRasterFormat(format);
  const lossyFormat = format === "jpeg" || format === "webp";
  const quality = format === "webp" ? webpQuality : jpegQuality;
  const qualityNumber = Number(quality);
  const qualityValid =
    Number.isFinite(qualityNumber) &&
    qualityNumber >= 10 &&
    qualityNumber <= 100;
  const rasterLabel =
    format === "jpeg" ? "JPEG" : format === "webp" ? "WebP" : "PNG";

  function run() {
    if (rasterFormat && rasterScale === "custom" && !customWidthValid) {
      setToast(
        `Raster width must be between 1 and ${MAX_RASTER_DIMENSION.toLocaleString()} px.`,
      );
      return;
    }
    if (lossyFormat && !qualityValid) {
      setToast("JPEG and WebP quality must be between 10% and 100%.");
      return;
    }

    const base = {
      scope: effectiveScope,
      selectionIds: selectedNodeIds,
    };
    let request: ExportRequest;
    if (format === "svg") {
      request = {
        ...base,
        format,
        settings: {
          precision: Number(precision) || 0,
          minify,
          outlineText,
        },
      };
    } else if (format === "png") {
      request = {
        ...base,
        format,
        settings: {
          scale: rasterScale,
          customWidth: customWidthNumber,
          transparentBackground: transparent,
          backgroundColor,
        },
      };
    } else if (format === "jpeg") {
      request = {
        ...base,
        format,
        settings: {
          scale: rasterScale,
          customWidth: customWidthNumber,
          quality: qualityNumber / 100,
          backgroundColor,
        },
      };
    } else if (format === "webp") {
      request = {
        ...base,
        format,
        settings: {
          scale: rasterScale,
          customWidth: customWidthNumber,
          quality: qualityNumber / 100,
          transparentBackground: transparent,
          backgroundColor,
        },
      };
    } else {
      request = { ...base, format };
    }

    setBusy(true);
    const job = runExport(request).pipe(
      Effect.map(() => null),
      // Typed failures become a toast; the dialog stays open to retry.
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.warn("Export failed", error);
          return "reason" in error && typeof error.reason === "string"
            ? error.reason
            : "Export failed — see the console for details.";
        }),
      ),
    );

    void Effect.runPromise(job)
      .then((message) => {
        if (message) {
          setToast(message);
        } else {
          setOpen(false);
        }
      })
      .finally(() => setBusy(false));
  }

  const activeArtboard = getActiveArtboard(documentStore.document);
  const activeName = activeArtboard.name;

  // Live preview: what the export will actually contain. Raster formats
  // composite onto the chosen background (or a checkerboard when
  // transparent), so the surface below mirrors the real output.
  const selectionPreview = effectiveScope === "selection";
  const previewTransparent =
    format === "ico" ||
    ((format === "png" || format === "webp") && transparent);
  const previewSvg = selectionPreview
    ? nodesToSvg(documentStore.document, selectedNodeIds)
    : documentToSvg(documentStore.document, activeArtboard, {
        transparentBackground: format !== "svg",
      });
  const previewSurfaceStyle =
    !selectionPreview && rasterFormat && !previewTransparent
      ? { background: backgroundColor }
      : undefined;
  const outputScale =
    rasterFormat && rasterScale !== "custom" ? rasterScale : null;
  const outputSize = !rasterFormat
    ? `${activeArtboard.width} × ${activeArtboard.height}`
    : rasterScale === "custom"
      ? customWidthValid
        ? `${customWidthNumber} × ${Math.round(
            (activeArtboard.height / activeArtboard.width) *
              customWidthNumber,
          )} px`
        : "—"
      : `${activeArtboard.width * (outputScale ?? 1)} × ${
          activeArtboard.height * (outputScale ?? 1)
        } px`;

  return (
    <div
      ref={dialogRef}
      className="overlay-in fixed inset-0 z-40 grid place-items-center bg-scrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          setOpen(false);
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={EXPORT_DIALOG_TITLE_ID}
      tabIndex={-1}
    >
      <div
        className="dialog-in w-[min(640px,calc(100vw-40px))] rounded-panel border border-panel-hairline bg-panel p-16 shadow-panel"
        aria-busy={busy}
      >
        <h2
          id={EXPORT_DIALOG_TITLE_ID}
          className="mb-12 mt-0 text-[13px] font-[650] text-ink"
        >
          Export
        </h2>
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {busy ? "Export in progress." : ""}
        </span>

        <div className="mb-14 flex gap-16">
        <div className="flex w-[248px] flex-none flex-col gap-8">
          <div
            className={`grid aspect-[4/3] place-items-center overflow-hidden rounded-card border border-panel-hairline p-10 ${
              previewSurfaceStyle ? "" : "preview-transparency"
            }`}
            style={previewSurfaceStyle}
            aria-hidden="true"
          >
            {previewSvg ? (
              <div
                className="grid h-full w-full place-items-center [&>svg]:h-full [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: previewSvg }}
              />
            ) : (
              <span className="text-[11px] text-ink-dim">No preview</span>
            )}
          </div>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-10 gap-y-4 text-[11px] text-ink-dim">
            <dt className="font-[600]">Output</dt>
            <dd className="m-0 truncate text-right tabular-nums text-ink">
              {selectionPreview ? "Selection bounds" : outputSize}
            </dd>
            <dt className="font-[600]">Files</dt>
            <dd className="m-0 truncate text-right text-ink">
              {effectiveScope === "selection"
                ? "1 · selection"
                : `${fileCount} · ${
                    effectiveScope === "all"
                      ? "board names"
                      : `“${activeName}”`
                  }`}
            </dd>
          </dl>
        </div>

        <div className="min-w-0 flex-1">
        <div
          className="mb-10 flex gap-2 rounded-m border border-field-border bg-field p-2"
          role="group"
          aria-label="Export scope"
        >
          {SCOPES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`${TAB_BASE} ${
                effectiveScope === item.id ? TAB_ON : "text-ink-dim"
              }`}
              disabled={busy || (item.id === "selection" && !hasSelection)}
              onClick={() => setScope(item.id)}
              aria-pressed={effectiveScope === item.id}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div
          className="mb-12 grid grid-cols-5 gap-2 rounded-m border border-field-border bg-field p-2"
          role="group"
          aria-label="Export format"
        >
          {FORMATS.map((item) => (
            <button
              key={item.id}
              type="button"
              data-format={item.id}
              className={`${TAB_BASE} ${
                format === item.id ? TAB_ON : "text-ink-dim"
              }`}
              disabled={busy}
              onClick={() => setFormat(item.id)}
              aria-pressed={format === item.id}
            >
              {item.label}
            </button>
          ))}
        </div>

        {format === "svg" && (
          <div className="mb-12 grid gap-8">
            <label className={ROW}>
              Precision
              <span className="flex items-center gap-4">
                <input
                  className={FIELD}
                  type="number"
                  min="0"
                  max="6"
                  value={precision}
                  disabled={busy}
                  onChange={(event) => setPrecision(event.target.value)}
                  aria-label="SVG precision digits"
                />
                digits
              </span>
            </label>
            <label className={CHECK}>
              <input
                type="checkbox"
                className="accent-accent"
                checked={minify}
                disabled={busy}
                onChange={(event) => setMinify(event.target.checked)}
                aria-label="Minify SVG"
              />
              Minify
            </label>
            <label className={CHECK}>
              <input
                type="checkbox"
                className="accent-accent"
                checked={outlineText}
                disabled={busy}
                onChange={(event) => setOutlineText(event.target.checked)}
                aria-label="Outline text on export"
              />
              Outline text (document keeps live text)
            </label>
          </div>
        )}

        {rasterFormat && (
          <div className="mb-12 grid gap-8">
            <div
              className="flex gap-2 rounded-m border border-field-border bg-field p-2"
              role="group"
              aria-label={`${rasterLabel} scale`}
            >
              {[1, 2, 3].map((scaleOption) => (
                <button
                  key={scaleOption}
                  type="button"
                  className={`${TAB_BASE} ${
                    rasterScale === scaleOption ? TAB_ON : "text-ink-dim"
                  }`}
                  disabled={busy}
                  onClick={() => setRasterScale(scaleOption as 1 | 2 | 3)}
                  aria-pressed={rasterScale === scaleOption}
                >
                  {scaleOption}×
                </button>
              ))}
              <button
                type="button"
                className={`${TAB_BASE} ${
                  rasterScale === "custom" ? TAB_ON : "text-ink-dim"
                }`}
                disabled={busy}
                onClick={() => setRasterScale("custom")}
                aria-pressed={rasterScale === "custom"}
              >
                Custom
              </button>
            </div>
            {rasterScale === "custom" && (
              <>
                <label className={ROW}>
                  Width
                  <span className="flex items-center gap-4">
                    <input
                      className={FIELD}
                      type="number"
                      min="1"
                      max={MAX_RASTER_DIMENSION}
                      step="1"
                      value={customWidth}
                      disabled={busy}
                      onChange={(event) => setCustomWidth(event.target.value)}
                      aria-label={`Custom ${rasterLabel} width`}
                      aria-invalid={!customWidthValid}
                      aria-describedby={
                        customWidthValid ? undefined : CUSTOM_WIDTH_ERROR_ID
                      }
                      aria-errormessage={
                        customWidthValid ? undefined : CUSTOM_WIDTH_ERROR_ID
                      }
                    />
                    px
                  </span>
                </label>
                {!customWidthValid && (
                  <p
                    id={CUSTOM_WIDTH_ERROR_ID}
                    className="m-0 text-[11px] text-red-600"
                    role="alert"
                  >
                    Enter a width from 1 to{" "}
                    {MAX_RASTER_DIMENSION.toLocaleString()} px.
                  </p>
                )}
              </>
            )}
            {(format === "png" || format === "webp") && (
              <label className={CHECK}>
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={transparent}
                  disabled={busy}
                  onChange={(event) => setTransparent(event.target.checked)}
                  aria-label={`${rasterLabel} transparent background`}
                />
                Transparent background
              </label>
            )}
            {lossyFormat && (
              <>
                <label className={ROW}>
                  Quality
                  <span className="flex items-center gap-4">
                    <input
                      className={FIELD}
                      type="number"
                      min="10"
                      max="100"
                      step="1"
                      value={quality}
                      disabled={busy}
                      onChange={(event) => {
                        if (format === "webp") {
                          setWebpQuality(event.target.value);
                        } else {
                          setJpegQuality(event.target.value);
                        }
                      }}
                      aria-label={`${rasterLabel} quality`}
                      aria-invalid={!qualityValid}
                      aria-describedby={
                        qualityValid ? undefined : QUALITY_ERROR_ID
                      }
                      aria-errormessage={
                        qualityValid ? undefined : QUALITY_ERROR_ID
                      }
                    />
                    %
                  </span>
                </label>
                {!qualityValid && (
                  <p
                    id={QUALITY_ERROR_ID}
                    className="m-0 text-[11px] text-red-600"
                    role="alert"
                  >
                    Enter a quality from 10% to 100%.
                  </p>
                )}
              </>
            )}
            {(format === "jpeg" || !transparent) && (
              <label className={ROW}>
                Background
                <span className="flex items-center gap-6">
                  <input
                    type="color"
                    className="h-24 w-32 cursor-pointer rounded-field border border-field-border bg-field p-1 disabled:cursor-default"
                    value={backgroundColor}
                    disabled={busy}
                    onChange={(event) => setBackgroundColor(event.target.value)}
                    aria-label={`${rasterLabel} background color`}
                  />
                  <span className="w-56 font-mono text-[11px] uppercase text-ink-dim">
                    {backgroundColor}
                  </span>
                </span>
              </label>
            )}
            {format === "jpeg" && (
              <p className="m-0 text-[11px] leading-[1.5] text-ink-dim">
                JPEG is opaque. Transparent pixels use the selected background.
              </p>
            )}
          </div>
        )}

        {format === "ico" && (
          <p className="mb-12 mt-0 text-[12px] leading-[1.5] text-ink-dim">
            One .ico per board with 16, 32 and 48&nbsp;px images
            (PNG-compressed entries, transparent background).
          </p>
        )}

        </div>
        </div>

        <div className="flex items-center justify-between gap-8 border-t border-panel-hairline pt-12">
          <button
            type="button"
            className={BUTTON}
            title="svg · mono · reversed · favicons"
            onClick={() => {
              setBusy(true);
              void Effect.runPromise(exportPack)
                .then(() => setOpen(false))
                .catch((error: unknown) => {
                  console.warn("Export pack failed", error);
                  setToast(
                    error &&
                      typeof error === "object" &&
                      "reason" in error &&
                      typeof error.reason === "string"
                      ? error.reason
                      : "Export pack failed — try a smaller artboard.",
                  );
                })
                .finally(() => setBusy(false));
            }}
            disabled={busy}
          >
            Export pack
          </button>
          <span className="flex gap-8">
            <button
              type="button"
              className={BUTTON}
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className={PRIMARY}
              disabled={
                busy ||
                (rasterFormat &&
                  rasterScale === "custom" &&
                  !customWidthValid) ||
                (lossyFormat && !qualityValid)
              }
              onClick={run}
              aria-label="Run export"
            >
              {busy ? "Exporting…" : "Export"}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
