import { useMemo } from "react";
import { getActiveArtboard } from "@openlogo/core";
import { documentToSvg } from "../lib/export";
import { useDocument } from "../state/document";

const SIZES = [128, 64, 32, 16];

/**
 * Small-size production previews. Rendered from the exported SVG string so
 * what you see here is literally what an export produces.
 */
export function PreviewStrip() {
  const document = useDocument();
  const artboard = getActiveArtboard(document);

  const dataUrl = useMemo(() => {
    const svg = documentToSvg(document);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }, [document]);

  return (
    <section className="preview-strip" aria-label="Logo production previews">
      {SIZES.map((size) => (
        <div className="preview-card" key={size}>
          <span>{size}px</span>
          <img
            src={dataUrl}
            width={size}
            height={Math.max(
              16,
              Math.round((size * artboard.height) / artboard.width),
            )}
            alt={`${size}px preview`}
          />
        </div>
      ))}
    </section>
  );
}
