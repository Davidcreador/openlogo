import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Maximize, Minus, Plus } from "lucide-react";
import { getActiveArtboard } from "@openlogo/core";
import { fitBounds, zoomAt } from "@openlogo/renderer";
import { documentStore } from "../state/document";
import { useEditorStore } from "../state/editor-store";

const ZOOM_PRESETS = [0.5, 1, 2] as const;

export function ZoomControls() {
  const camera = useEditorStore((state) => state.camera);
  const setCamera = useEditorStore((state) => state.setCamera);
  const viewport = useEditorStore((state) => state.viewport);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const zoomPercent = Math.round(camera.zoom * 100);
  const canFit = viewport.width > 0 && viewport.height > 0;

  useEffect(() => {
    if (!open) {
      return;
    }

    function closeMenu(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    window.addEventListener("pointerdown", closeMenu);
    return () => window.removeEventListener("pointerdown", closeMenu);
  }, [open]);

  function zoomBy(factor: number) {
    const center = { x: viewport.width / 2, y: viewport.height / 2 };
    setCamera(zoomAt(camera, center, camera.zoom * factor));
  }

  function zoomTo(zoom: number) {
    const center = { x: viewport.width / 2, y: viewport.height / 2 };
    setCamera(zoomAt(camera, center, zoom));
    setOpen(false);
  }

  function fit() {
    if (viewport.width === 0) {
      return;
    }
    const artboard = getActiveArtboard(documentStore.document);
    setCamera(fitBounds(artboard, viewport.width, viewport.height));
    setOpen(false);
  }

  const button =
    "h-30 min-w-30 place-items-center rounded-m text-ink-dim hover:enabled:bg-field hover:enabled:text-ink disabled:cursor-not-allowed disabled:opacity-40";
  const iconButton = `chrome-tooltip chrome-tooltip-top relative grid ${button}`;

  return (
    <div
      ref={ref}
      className="zoom-controls absolute bottom-16 right-16 z-30 flex items-center gap-1 rounded-[11px] border border-panel-hairline bg-card p-3 shadow-float"
      role="group"
      aria-label="Zoom"
    >
      <button
        type="button"
        className={iconButton}
        onClick={() => zoomBy(1 / 1.25)}
        data-tooltip="Zoom out"
        aria-label="Zoom out"
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`${button} zoom-value flex min-w-70 items-center gap-4 px-8 text-[11.5px] font-[650] tabular-nums text-ink`}
        onClick={() => setOpen((value) => !value)}
        data-tooltip="Zoom presets"
        aria-label={`Zoom presets. Current zoom ${zoomPercent} percent`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="zoom-presets"
      >
        <span>{zoomPercent}%</span>
        <ChevronDown
          size={11}
          className={`text-ink-dim transition-transform duration-140 ease-studio ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      <button
        type="button"
        className={iconButton}
        onClick={() => zoomBy(1.25)}
        data-tooltip="Zoom in"
        aria-label="Zoom in"
      >
        <Plus size={14} aria-hidden="true" />
      </button>
      <span className="mx-2 h-18 w-px bg-panel-hairline" aria-hidden="true" />
      <button
        type="button"
        className={iconButton}
        onClick={fit}
        data-tooltip="Fit artboard"
        aria-label="Fit artboard"
        disabled={!canFit}
      >
        <Maximize size={14} aria-hidden="true" />
      </button>

      {open && (
        <div
          id="zoom-presets"
          className="menu zoom-menu min-w-132"
          role="menu"
          aria-label="Zoom presets"
        >
          <button
            type="button"
            className="menu-item"
            onClick={fit}
            disabled={!canFit}
            role="menuitem"
          >
            <span className="menu-check">
              <Maximize size={13} aria-hidden="true" />
            </span>
            <span className="menu-label">Fit</span>
          </button>
          <div className="menu-divider" />
          {ZOOM_PRESETS.map((zoom) => {
            const percent = zoom * 100;
            const active = zoomPercent === percent;
            return (
              <button
                key={zoom}
                type="button"
                className="menu-item"
                onClick={() => zoomTo(zoom)}
                role="menuitemradio"
                aria-checked={active}
              >
                <span className="menu-check">
                  {active && <Check size={13} aria-hidden="true" />}
                </span>
                <span className="menu-label">{percent}%</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
