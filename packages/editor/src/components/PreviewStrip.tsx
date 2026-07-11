import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { type LogoDocument, getActiveArtboard } from "@openlogo/core";
import { documentToSvg } from "../lib/export";
import { useDocument } from "../state/document";

export const PREVIEW_SIZES = [128, 64, 48, 32, 16] as const;

export type PreviewSurface = "artboard" | "light" | "dark" | "transparent";

const SURFACES: {
  id: PreviewSurface;
  label: string;
  swatchClass: string;
}[] = [
  {
    id: "artboard",
    label: "Artboard",
    swatchClass: "border-panel-border",
  },
  {
    id: "light",
    label: "Light",
    swatchClass: "border-panel-border bg-white",
  },
  {
    id: "dark",
    label: "Dark",
    swatchClass: "border-transparent bg-chrome",
  },
  {
    id: "transparent",
    label: "Clear",
    swatchClass: "preview-transparency border-panel-border",
  },
];

export function productionPreviewSvg(
  document: LogoDocument,
  surface: PreviewSurface,
): string {
  return documentToSvg(document, getActiveArtboard(document), {
    transparentBackground: surface !== "artboard",
  });
}

/**
 * Floating production-size checks. Inline SVG keeps custom DOM FontFaces
 * available while using the same tree walk as the real export.
 */
export function PreviewStrip() {
  const document = useDocument();
  const [open, setOpen] = useState(true);
  const [surface, setSurface] = useState<PreviewSurface>("artboard");
  const artboard = getActiveArtboard(document);

  const svg = useMemo(
    () => productionPreviewSvg(document, surface),
    [document, surface],
  );
  const surfaceColor =
    surface === "artboard"
      ? artboard.background
      : surface === "light"
        ? "#ffffff"
        : surface === "dark"
          ? "#17151b"
          : undefined;

  return (
    <div
      className="preview-dock absolute bottom-16 left-16 z-10 overflow-hidden rounded-[12px] border border-panel-hairline bg-card shadow-float"
    >
      <button
        type="button"
        className="preview-toggle flex w-full items-center justify-between gap-16 px-12 py-9 text-left transition-colors duration-140 ease-studio hover:bg-field/60"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="logo-production-previews"
      >
        <span className="grid gap-1">
          <span className="text-[11px] font-[680] text-ink">Size check</span>
          <span className="text-[9.5px] font-medium text-ink-dim">
            Export rendering · 16–128 px
          </span>
        </span>
        <ChevronDown
          className={`text-ink-dim transition-transform duration-140 ease-studio ${
            open ? "" : "-rotate-90"
          }`}
          size={14}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div
          id="logo-production-previews"
          className="border-t border-panel-hairline px-12 pb-12 pt-9"
        >
          <div
            className="mb-10 flex items-center justify-between gap-12"
            role="group"
            aria-label="Preview background"
          >
            <span className="text-[9.5px] font-[650] uppercase tracking-[0.06em] text-ink-dim">
              Background
            </span>
            <div className="flex items-center gap-3">
              {SURFACES.map((option) => {
                const selected = surface === option.id;
                return (
                  <button
                    type="button"
                    className={`flex h-22 items-center gap-4 rounded-[5px] border px-5 text-[9px] font-medium transition-all duration-140 ease-studio ${
                      selected
                        ? "border-accent bg-accent-soft text-[#a78fff]"
                        : "border-transparent text-ink-dim hover:bg-field hover:text-ink"
                    }`}
                    key={option.id}
                    onClick={() => setSurface(option.id)}
                    aria-label={`${option.label} background`}
                    aria-pressed={selected}
                    title={option.label}
                  >
                    <span
                      className={`h-10 w-10 rounded-[3px] border ${option.swatchClass}`}
                      style={
                        option.id === "artboard"
                          ? { backgroundColor: artboard.background }
                          : undefined
                      }
                      aria-hidden="true"
                    />
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div
            className={`flex items-end justify-center gap-16 rounded-[10px] border border-panel-hairline px-16 pb-8 pt-14 shadow-[inset_0_1px_2px_rgb(0_0_0/0.22)] ${
              surface === "transparent" ? "preview-transparency" : ""
            }`}
            style={{ backgroundColor: surfaceColor }}
            role="group"
            aria-label={`Logo production previews on ${surface} background`}
          >
            {PREVIEW_SIZES.map((size) => {
              const height = Math.max(
                12,
                Math.round((size * artboard.height) / artboard.width),
              );
              return (
                <figure
                  className="preview-card m-0 grid justify-items-center gap-6"
                  key={size}
                >
                  <div
                    className="production-preview grid items-center overflow-hidden"
                    style={{ width: size, height }}
                    dangerouslySetInnerHTML={{ __html: svg }}
                  />
                  <figcaption
                    className={`text-[9.5px] font-medium tabular-nums ${
                      surface === "dark" ? "text-white/55" : "text-ink-dim"
                    }`}
                  >
                    {size}
                    <span
                      className={`ml-1 text-[8px] ${
                        surface === "dark"
                          ? "text-white/35"
                          : "text-ink-dim/70"
                      }`}
                    >
                      px
                    </span>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
