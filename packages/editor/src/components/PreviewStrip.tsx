import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { getActiveArtboard } from "@openlogo/core";
import { documentToSvg } from "../lib/export";
import { useDocument } from "../state/document";

const SIZES = [128, 64, 32, 16];

/**
 * Floating small-size production previews, rendered from the exported SVG
 * string so what you see is literally what an export produces.
 */
export function PreviewStrip() {
  const document = useDocument();
  const [open, setOpen] = useState(true);
  const artboard = getActiveArtboard(document);

  const dataUrl = useMemo(() => {
    const svg = documentToSvg(document);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }, [document]);

  return (
    <div
      className={`preview-dock absolute bottom-16 left-16 z-10 overflow-hidden rounded-[12px] border border-panel-hairline bg-card shadow-float ${
        open ? "" : "collapsed"
      }`}
    >
      <button
        type="button"
        className="preview-toggle flex w-full items-center gap-6 px-12 py-8 text-[10.5px] font-[650] uppercase tracking-[0.07em] text-ink-dim transition-colors duration-140 ease-studio hover:text-ink"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span>Preview</span>
        {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </button>
      {open && (
        <div
          className="flex items-end gap-12 px-12 pb-12 pt-2"
          aria-label="Logo production previews"
        >
          {SIZES.map((size) => (
            <div className="preview-card grid justify-items-center gap-4" key={size}>
              <img
                className="rounded-[6px] border border-panel-hairline bg-white shadow-[0_1px_2px_rgb(28_25_33/0.05)]"
                src={dataUrl}
                width={size}
                height={Math.max(
                  12,
                  Math.round((size * artboard.height) / artboard.width),
                )}
                alt={`${size}px preview`}
              />
              <span className="text-[10px] tabular-nums text-ink-dim">{size}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
