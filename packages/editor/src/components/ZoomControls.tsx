import { Maximize, Minus, Plus } from "lucide-react";
import { getActiveArtboard } from "@openlogo/core";
import { fitBounds, zoomAt } from "@openlogo/renderer";
import { documentStore } from "../state/document";
import { useEditorStore } from "../state/editor-store";

export function ZoomControls() {
  const camera = useEditorStore((state) => state.camera);
  const setCamera = useEditorStore((state) => state.setCamera);
  const viewport = useEditorStore((state) => state.viewport);
  const zoomPercent = Math.round(camera.zoom * 100);
  const canFit = viewport.width > 0 && viewport.height > 0;

  function zoomBy(factor: number) {
    const center = { x: viewport.width / 2, y: viewport.height / 2 };
    setCamera(zoomAt(camera, center, camera.zoom * factor));
  }

  function fit() {
    if (viewport.width === 0) {
      return;
    }
    const artboard = getActiveArtboard(documentStore.document);
    setCamera(fitBounds(artboard, viewport.width, viewport.height));
  }

  const button =
    "grid h-28 min-w-28 place-items-center rounded-m text-ink-dim transition-colors duration-140 ease-studio hover:enabled:bg-field hover:enabled:text-ink disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div
      className="zoom-controls absolute bottom-16 right-16 z-10 flex items-center gap-1 rounded-[11px] border border-panel-hairline bg-card p-3 shadow-float"
      role="group"
      aria-label="Zoom"
    >
      <button
        type="button"
        className={button}
        onClick={() => zoomBy(1 / 1.25)}
        aria-label="Zoom out"
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`${button} zoom-value px-8 text-[11.5px] font-semibold tabular-nums`}
        onClick={fit}
        title="Fit artboard"
        aria-label={`Fit artboard to view. Current zoom ${zoomPercent} percent`}
        disabled={!canFit}
      >
        {zoomPercent}%
      </button>
      <button
        type="button"
        className={button}
        onClick={() => zoomBy(1.25)}
        aria-label="Zoom in"
      >
        <Plus size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={button}
        onClick={fit}
        title="Fit artboard"
        aria-label="Fit artboard"
        disabled={!canFit}
      >
        <Maximize size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
