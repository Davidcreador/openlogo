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
    <div className={`preview-dock ${open ? "" : "collapsed"}`}>
      <button
        type="button"
        className="preview-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span>Preview</span>
        {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </button>
      {open && (
        <div className="preview-cards" aria-label="Logo production previews">
          {SIZES.map((size) => (
            <div className="preview-card" key={size}>
              <img
                src={dataUrl}
                width={size}
                height={Math.max(
                  12,
                  Math.round((size * artboard.height) / artboard.width),
                )}
                alt={`${size}px preview`}
              />
              <span>{size}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
