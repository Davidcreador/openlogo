import { Maximize, Minus, Plus } from "lucide-react";
import { getActiveArtboard } from "@openlogo/core";
import { fitBounds, zoomAt } from "@openlogo/renderer";
import { documentStore } from "../state/document";
import { useEditorStore } from "../state/editor-store";

export function ZoomControls() {
  const camera = useEditorStore((state) => state.camera);
  const setCamera = useEditorStore((state) => state.setCamera);
  const viewport = useEditorStore((state) => state.viewport);

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

  return (
    <div className="zoom-controls" role="group" aria-label="Zoom">
      <button type="button" onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom out">
        <Minus size={14} />
      </button>
      <button type="button" className="zoom-value" onClick={fit} title="Fit artboard">
        {Math.round(camera.zoom * 100)}%
      </button>
      <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
        <Plus size={14} />
      </button>
      <button type="button" onClick={fit} title="Fit artboard" aria-label="Fit artboard">
        <Maximize size={14} />
      </button>
    </div>
  );
}
