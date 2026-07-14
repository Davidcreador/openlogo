import { useCallback, useEffect, useRef } from "react";
import { getActiveArtboard } from "@openlogo/core";
import { documentStore, useDocument } from "../state/document";
import { useEditorStore } from "../state/editor-store";

/** Ruler thickness in CSS px. Guide-drag scripts press inside this band. */
const RULER_SIZE = 20;

// Canvas 2D can't resolve CSS custom properties; these mirror styles.css
// tokens per theme (guide mark = --accent = renderer selection color).
type RulerColors = {
  tickMinor: string;
  tickMid: string;
  tickMajor: string;
  label: string;
  guideMark: string;
};

const RULER_THEMES: Record<"dark" | "light", RulerColors> = {
  dark: {
    tickMinor: "rgb(233 231 240 / 0.14)",
    tickMid: "rgb(233 231 240 / 0.24)",
    tickMajor: "rgb(233 231 240 / 0.42)",
    label: "rgb(233 231 240 / 0.55)",
    guideMark: "#7c5cff",
  },
  light: {
    tickMinor: "rgb(28 25 33 / 0.16)",
    tickMid: "rgb(28 25 33 / 0.26)",
    tickMajor: "rgb(28 25 33 / 0.44)",
    label: "rgb(35 32 40 / 0.6)",
    guideMark: "#4f6bf6",
  },
};

const LABEL_FONT =
  '500 9px Inter, ui-sans-serif, system-ui, -apple-system, sans-serif';

/** Smallest labelled step (artboard units) that keeps ≥56px between labels. */
function pickLabelStep(zoom: number): number {
  const ladder = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
  for (const step of ladder) {
    if (step * zoom >= 56) {
      return step;
    }
  }
  return 25000;
}

/** Finest subdivision of the labelled step that keeps ≥5px between ticks. */
function pickMinorDivisions(labelStep: number, zoom: number): number {
  for (const divisions of [10, 5, 2]) {
    if ((labelStep / divisions) * zoom >= 5) {
      return divisions;
    }
  }
  return 1;
}

/**
 * Draw one ruler scale. `origin` is the screen position (in this canvas's
 * own CSS px) of artboard coordinate 0, so a tick for artboard value `a`
 * lands at `origin + a * zoom` — exactly the camera's world→screen mapping.
 */
function drawScale(
  canvas: HTMLCanvasElement,
  axis: "x" | "y",
  zoom: number,
  origin: number,
  guides: number[],
  colors: RulerColors,
) {
  const rect = canvas.getBoundingClientRect();
  const length = axis === "x" ? rect.width : rect.height;
  if (length <= 0) {
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const deviceW = Math.round(rect.width * dpr);
  const deviceH = Math.round(rect.height * dpr);
  if (canvas.width !== deviceW || canvas.height !== deviceH) {
    canvas.width = deviceW;
    canvas.height = deviceH;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const labelStep = pickLabelStep(zoom);
  const divisions = pickMinorDivisions(labelStep, zoom);
  const minorStep = labelStep / divisions;

  const firstIndex = Math.floor((0 - origin) / (minorStep * zoom));
  const lastIndex = Math.ceil((length - origin) / (minorStep * zoom));
  ctx.font = LABEL_FONT;
  ctx.textBaseline = "alphabetic";

  for (let i = firstIndex; i <= lastIndex; i++) {
    const value = i * minorStep;
    const screen = origin + value * zoom;
    const pos = Math.round(screen);
    const isMajor = i % divisions === 0;
    const isMid = !isMajor && divisions % 2 === 0 && i % (divisions / 2) === 0;
    const size = isMajor ? 9 : isMid ? 6 : 4;
    ctx.fillStyle = isMajor
      ? colors.tickMajor
      : isMid
        ? colors.tickMid
        : colors.tickMinor;

    if (axis === "x") {
      ctx.fillRect(pos, RULER_SIZE - size, 1, size);
    } else {
      ctx.fillRect(RULER_SIZE - size, pos, size, 1);
    }

    if (isMajor) {
      ctx.fillStyle = colors.label;
      const label = String(Math.round(value));
      if (axis === "x") {
        ctx.fillText(label, pos + 4, 9);
      } else {
        // Rotated so left-ruler labels read bottom-up along the strip.
        ctx.save();
        ctx.translate(9, pos - 4);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    }
  }

  // Existing guides get a small accent notch at the canvas edge.
  ctx.fillStyle = colors.guideMark;
  for (const guide of guides) {
    const pos = Math.round(origin + guide * zoom);
    if (pos < -3 || pos > length + 3) {
      continue;
    }
    if (axis === "x") {
      ctx.fillRect(pos - 1, RULER_SIZE - 4, 3, 4);
    } else {
      ctx.fillRect(RULER_SIZE - 4, pos - 1, 4, 3);
    }
  }
}

/**
 * Labelled rulers along the top/left canvas edges. Pure chrome: guide
 * creation stays in CanvasStage and is passed in as pointer handlers so the
 * drag → artboard-coordinate math lives next to the other gesture code.
 */
export function CanvasRulers({
  onGuideStart,
  onGuideMove,
  onGuideEnd,
}: {
  onGuideStart: (
    axis: "v" | "h",
  ) => (event: React.PointerEvent<HTMLDivElement>) => void;
  onGuideMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onGuideEnd: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const document = useDocument();
  const camera = useEditorStore((state) => state.camera);
  const theme = useEditorStore((state) => state.theme);
  const topRef = useRef<HTMLCanvasElement | null>(null);
  const leftRef = useRef<HTMLCanvasElement | null>(null);
  const cursorTopRef = useRef<HTMLDivElement | null>(null);
  const cursorLeftRef = useRef<HTMLDivElement | null>(null);

  const draw = useCallback(() => {
    const top = topRef.current;
    const left = leftRef.current;
    if (!top || !left) {
      return;
    }
    const cam = useEditorStore.getState().camera;
    const colors = RULER_THEMES[useEditorStore.getState().theme];
    const artboard = getActiveArtboard(documentStore.document);
    // Both ruler strips sit RULER_SIZE px in from the host origin, and the
    // GPU canvas fills the host, so screen-space minus RULER_SIZE is exact.
    drawScale(
      top,
      "x",
      cam.zoom,
      (artboard.x - cam.offset.x) * cam.zoom - RULER_SIZE,
      artboard.guides?.v ?? [],
      colors,
    );
    drawScale(
      left,
      "y",
      cam.zoom,
      (artboard.y - cam.offset.y) * cam.zoom - RULER_SIZE,
      artboard.guides?.h ?? [],
      colors,
    );
  }, []);

  useEffect(() => {
    draw();
  }, [draw, document, camera, theme]);

  useEffect(() => {
    const host = topRef.current?.closest<HTMLElement>(".canvas-host");
    if (!host) {
      return;
    }

    const observer = new ResizeObserver(draw);
    observer.observe(host);

    // Cursor position indicators, driven outside React (one transform per
    // pointermove, no re-render).
    const onMove = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      const x = event.clientX - rect.left - RULER_SIZE;
      const y = event.clientY - rect.top - RULER_SIZE;
      if (cursorTopRef.current) {
        cursorTopRef.current.style.opacity = x >= 0 ? "1" : "0";
        cursorTopRef.current.style.transform = `translateX(${x}px)`;
      }
      if (cursorLeftRef.current) {
        cursorLeftRef.current.style.opacity = y >= 0 ? "1" : "0";
        cursorLeftRef.current.style.transform = `translateY(${y}px)`;
      }
    };
    const onLeave = () => {
      if (cursorTopRef.current) {
        cursorTopRef.current.style.opacity = "0";
      }
      if (cursorLeftRef.current) {
        cursorLeftRef.current.style.opacity = "0";
      }
    };
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);
    return () => {
      observer.disconnect();
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
    };
  }, [draw]);

  // Frosted panel material shared by both strips and the corner square
  // (--ruler-mat/-hover are themed in styles.css).
  const material =
    "absolute bg-[var(--ruler-mat)] backdrop-blur-[10px] backdrop-saturate-[1.15]";
  const strip = `ruler ${material} z-15 overflow-hidden transition-colors duration-140 ease-studio hover:bg-[var(--ruler-mat-hover)]`;
  const cursor = "ruler-cursor pointer-events-none absolute left-0 top-0 bg-accent opacity-0";

  return (
    <>
      <div
        className={`${strip} ruler-top left-20 right-0 top-0 h-20 cursor-row-resize shadow-[inset_0_-1px_0_var(--color-panel-border)]`}
        onPointerDown={onGuideStart("h")}
        onPointerMove={onGuideMove}
        onPointerUp={onGuideEnd}
        title="Drag down to add a horizontal guide"
      >
        <canvas ref={topRef} className="pointer-events-none block h-full w-full" />
        <div ref={cursorTopRef} className={`${cursor} h-full w-px`} />
      </div>
      <div
        className={`${strip} ruler-left bottom-0 left-0 top-20 w-20 cursor-col-resize shadow-[inset_-1px_0_0_var(--color-panel-border)]`}
        onPointerDown={onGuideStart("v")}
        onPointerMove={onGuideMove}
        onPointerUp={onGuideEnd}
        title="Drag right to add a vertical guide"
      >
        <canvas ref={leftRef} className="pointer-events-none block h-full w-full" />
        <div ref={cursorLeftRef} className={`${cursor} h-px w-full`} />
      </div>
      <div
        className={`ruler-corner ${material} left-0 top-0 z-16 h-20 w-20 shadow-[inset_-1px_0_0_var(--color-panel-border),inset_0_-1px_0_var(--color-panel-border)]`}
      />
    </>
  );
}
