import { useState } from "react";
import { Effect } from "effect";
import { getActiveArtboard } from "@openlogo/core";
import { exportPack } from "../lib/export-pack";
import {
  type ExportFormat,
  type ExportScope,
  runExport,
} from "../lib/export-jobs";
import { documentStore, useDocument } from "../state/document";
import { useEditorStore } from "../state/editor-store";

const FIELD =
  "h-28 w-72 rounded-field border border-field-border bg-field px-8 text-[12.5px] tabular-nums text-ink outline-none transition-[border-color,box-shadow] duration-140 ease-studio focus:border-accent focus:bg-card focus:shadow-ring";
const TAB_BASE =
  "flex-1 rounded-[6px] py-5 text-[12px] transition-[background-color,color,box-shadow] duration-120 ease-studio disabled:cursor-default disabled:opacity-35";
const TAB_ON =
  "bg-card font-semibold text-ink shadow-[0_1px_2px_rgb(28_25_33/0.1)]";
const BUTTON =
  "rounded-field border border-field-border bg-card px-12 py-6 text-[12px] text-ink transition-[border-color,color] duration-140 ease-studio hover:border-accent hover:text-accent";
const PRIMARY =
  "rounded-field bg-accent px-12 py-6 text-[12px] font-semibold text-white transition-[filter] duration-140 ease-studio hover:brightness-[1.08]";
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
  { id: "ico", label: "ICO" },
];

/**
 * Export dialog: scope (active / all boards / selection) × format (SVG
 * with precision/minify/outline-text, PNG with scale + transparency,
 * true multi-image .ico). Filenames come from board names; the quick
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
  const [pngScale, setPngScale] = useState<number | "custom">(2);
  const [customWidth, setCustomWidth] = useState("1024");
  const [transparent, setTransparent] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return null;
  }

  const hasSelection = selectedNodeIds.length > 0;
  const effectiveScope =
    scope === "selection" && !hasSelection ? "active" : scope;
  const fileCount =
    effectiveScope === "all" ? document.artboards.length : 1;

  function run() {
    setBusy(true);
    const job = runExport({
      scope: effectiveScope,
      format,
      selectionIds: selectedNodeIds,
      svg: {
        precision: Number(precision) || 0,
        minify,
        outlineText,
      },
      png: {
        scale: pngScale,
        customWidth: Number(customWidth) || 1024,
        transparentBackground: transparent,
      },
    }).pipe(
      Effect.map(() => null),
      // Typed failures become a toast; the dialog stays open to retry.
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.warn("Export failed", error);
          return error._tag === "ExportSelectionError"
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

  const activeName = getActiveArtboard(documentStore.document).name;

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-[rgb(28_25_33/0.28)]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          setOpen(false);
        }
      }}
      role="dialog"
      aria-label="Export"
    >
      <div className="w-[340px] rounded-panel border border-panel-hairline bg-panel p-16 shadow-panel">
        <h2 className="mb-12 mt-0 text-[13px] font-[650] text-ink">Export</h2>

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
              disabled={item.id === "selection" && !hasSelection}
              onClick={() => setScope(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div
          className="mb-12 flex gap-2 rounded-m border border-field-border bg-field p-2"
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
              onClick={() => setFormat(item.id)}
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
                onChange={(event) => setOutlineText(event.target.checked)}
                aria-label="Outline text on export"
              />
              Outline text (document keeps live text)
            </label>
          </div>
        )}

        {format === "png" && (
          <div className="mb-12 grid gap-8">
            <div
              className="flex gap-2 rounded-m border border-field-border bg-field p-2"
              role="group"
              aria-label="PNG scale"
            >
              {[1, 2, 3].map((scaleOption) => (
                <button
                  key={scaleOption}
                  type="button"
                  className={`${TAB_BASE} ${
                    pngScale === scaleOption ? TAB_ON : "text-ink-dim"
                  }`}
                  onClick={() => setPngScale(scaleOption)}
                >
                  {scaleOption}×
                </button>
              ))}
              <button
                type="button"
                className={`${TAB_BASE} ${
                  pngScale === "custom" ? TAB_ON : "text-ink-dim"
                }`}
                onClick={() => setPngScale("custom")}
              >
                Custom
              </button>
            </div>
            {pngScale === "custom" && (
              <label className={ROW}>
                Width
                <span className="flex items-center gap-4">
                  <input
                    className={FIELD}
                    type="number"
                    min="1"
                    value={customWidth}
                    onChange={(event) => setCustomWidth(event.target.value)}
                    aria-label="Custom PNG width"
                  />
                  px
                </span>
              </label>
            )}
            <label className={CHECK}>
              <input
                type="checkbox"
                className="accent-accent"
                checked={transparent}
                onChange={(event) => setTransparent(event.target.checked)}
                aria-label="Transparent background"
              />
              Transparent background
            </label>
          </div>
        )}

        {format === "ico" && (
          <p className="mb-12 mt-0 text-[12px] leading-[1.5] text-ink-dim">
            One .ico per board with 16, 32 and 48&nbsp;px images
            (PNG-compressed entries, transparent background).
          </p>
        )}

        <p className="mb-12 mt-0 text-[11px] text-ink-dim">
          {effectiveScope === "selection"
            ? "1 file · selection"
            : `${fileCount} file${fileCount === 1 ? "" : "s"} · named after ${
                effectiveScope === "all" ? "board names" : `“${activeName}”`
              }`}
        </p>

        <div className="flex items-center justify-between gap-8">
          <button
            type="button"
            className={BUTTON}
            title="svg · mono · reversed · favicons"
            onClick={() => {
              void Effect.runPromise(exportPack);
              setOpen(false);
            }}
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
              disabled={busy}
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
