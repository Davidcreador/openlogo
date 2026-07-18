import { Plus } from "lucide-react";
import { type ArtboardSide, addArtboardBeside } from "../lib/artboard-ops";
import { useDocument } from "../state/document";
import { useEditorStore } from "../state/editor-store";

const SIDES: ReadonlyArray<{
  side: ArtboardSide;
  label: string;
}> = [
  { side: "left", label: "Add artboard to the left" },
  { side: "right", label: "Add artboard to the right" },
  { side: "top", label: "Add artboard above" },
  { side: "bottom", label: "Add artboard below" },
];

/** Gap between an artboard edge and its floating "+" button, px. */
const OFFSET = 18;

/**
 * Figma-style "+" buttons floating at the active artboard's edge
 * midpoints — one click adds a same-size artboard on that side.
 */
export function ArtboardEdgeControls() {
  const document = useDocument();
  const camera = useEditorStore((state) => state.camera);
  const viewport = useEditorStore((state) => state.viewport);
  const rendererReady = useEditorStore((state) => state.rendererReady);

  const artboard = document.artboards.find(
    (item) => item.id === document.activeArtboardId,
  );
  if (!rendererReady || !artboard || viewport.width === 0) {
    return null;
  }

  // World → screen: screen = (world - offset) × zoom.
  const toScreen = (x: number, y: number) => ({
    x: (x - camera.offset.x) * camera.zoom,
    y: (y - camera.offset.y) * camera.zoom,
  });
  const midX = artboard.x + artboard.width / 2;
  const midY = artboard.y + artboard.height / 2;
  const anchors: Record<ArtboardSide, { x: number; y: number }> = {
    left: toScreen(artboard.x, midY),
    right: toScreen(artboard.x + artboard.width, midY),
    top: toScreen(midX, artboard.y),
    bottom: toScreen(midX, artboard.y + artboard.height),
  };
  const shift: Record<ArtboardSide, { x: number; y: number }> = {
    left: { x: -OFFSET, y: 0 },
    right: { x: OFFSET, y: 0 },
    top: { x: 0, y: -OFFSET },
    bottom: { x: 0, y: OFFSET },
  };

  return (
    <>
      {SIDES.map(({ side, label }) => {
        const point = {
          x: anchors[side].x + shift[side].x,
          y: anchors[side].y + shift[side].y,
        };
        const visible =
          point.x >= 8 &&
          point.x <= viewport.width - 8 &&
          point.y >= 8 &&
          point.y <= viewport.height - 8;
        if (!visible) {
          return null;
        }
        return (
          <button
            key={side}
            type="button"
            className="chrome-tooltip chrome-tooltip-bottom absolute z-20 grid h-24 w-24 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-panel-hairline bg-panel/92 text-ink-dim opacity-55 shadow-[0_4px_14px_rgb(19_16_25/0.18)] transition-[opacity,color,background-color,border-color] hover:border-accent hover:bg-accent hover:text-white hover:opacity-100"
            style={{ left: point.x, top: point.y }}
            data-tooltip={label}
            aria-label={label}
            onClick={() => addArtboardBeside(artboard.id, side)}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        );
      })}
    </>
  );
}
