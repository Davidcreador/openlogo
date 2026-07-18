import type { Bounds, Vec2 } from "./geometry";
import type {
  GradientStop,
  LinearGradientPaint,
  Paint,
  RadialGradientPaint,
} from "./types";

/**
 * Pure gradient math shared by the renderer, the SVG export and the
 * on-canvas annotator. Gradient coordinates in the document are
 * normalized to the node's box (SVG objectBoundingBox semantics); these
 * helpers convert to/from absolute space and edit stop lists
 * immutably — every mutation returns a fresh Paint so update-nodes
 * patches stay exact-inverse.
 */

export type GradientPaint = LinearGradientPaint | RadialGradientPaint;

export function isGradient(paint: Paint): paint is GradientPaint {
  return paint.type === "linear-gradient" || paint.type === "radial-gradient";
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Absolute endpoints of a linear gradient for a node box. Explicit
 * normalized start/end win; otherwise the legacy angle form — a line
 * through the box centre with half-length max(w,h)/2, which is what the
 * renderer has always drawn for angle-only gradients.
 */
export function linearGradientPoints(
  paint: LinearGradientPaint,
  box: Bounds,
): { start: Vec2; end: Vec2 } {
  if (paint.start && paint.end) {
    return {
      start: {
        x: box.x + paint.start.x * box.width,
        y: box.y + paint.start.y * box.height,
      },
      end: {
        x: box.x + paint.end.x * box.width,
        y: box.y + paint.end.y * box.height,
      },
    };
  }
  const radians = (paint.angle * Math.PI) / 180;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const half = Math.max(box.width, box.height) / 2;
  const dx = Math.cos(radians) * half;
  const dy = Math.sin(radians) * half;
  return {
    start: { x: cx - dx, y: cy - dy },
    end: { x: cx + dx, y: cy + dy },
  };
}

/** Absolute centre / radii / focal of a radial gradient for a node box. */
export function radialGradientGeometry(
  paint: RadialGradientPaint,
  box: Bounds,
): { center: Vec2; rx: number; ry: number; focal: Vec2 | null } {
  return {
    center: {
      x: box.x + paint.cx * box.width,
      y: box.y + paint.cy * box.height,
    },
    rx: paint.r * box.width,
    ry: paint.r * box.height,
    focal:
      paint.fx !== undefined && paint.fy !== undefined
        ? { x: box.x + paint.fx * box.width, y: box.y + paint.fy * box.height }
        : null,
  };
}

/** Display angle (degrees) of the absolute start→end line. */
export function angleFromPoints(start: Vec2, end: Vec2): number {
  return (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
}

/**
 * Mirror a paint in node-box normalized space across the horizontal mid-
 * line (y → 1 − y). Matches the content-flip half of reflectLeafPatches
 * so fills reverse with the shape under Flip Vertical / Reflect.
 */
export function mirrorPaintVertically(paint: Paint): Paint {
  if (paint.type === "solid") {
    return paint;
  }
  if (paint.type === "linear-gradient") {
    if (paint.start && paint.end) {
      const start = { x: paint.start.x, y: 1 - paint.start.y };
      const end = { x: paint.end.x, y: 1 - paint.end.y };
      return {
        ...paint,
        start,
        end,
        angle: angleFromPoints(start, end),
      };
    }
    return { ...paint, angle: -paint.angle };
  }
  return {
    ...paint,
    cy: 1 - paint.cy,
    ...(paint.fy !== undefined ? { fy: 1 - paint.fy } : {}),
  };
}

/* ---------------- stop editing (immutable) ---------------- */

const HEX = /^#([0-9a-f]{6})$/i;

function hexChannels(color: string): [number, number, number] {
  const match = HEX.exec(color.trim());
  if (!match) {
    return [0, 0, 0];
  }
  const value = parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function toHex(channels: [number, number, number]): string {
  return `#${channels
    .map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Colour + alpha at offset t, linearly interpolated between stops. */
export function sampleStops(
  stops: GradientStop[],
  t: number,
): { color: string; alpha: number } {
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  const first = sorted[0];
  if (!first) {
    return { color: "#000000", alpha: 1 };
  }
  const clamped = clamp01(t);
  if (clamped <= first.offset) {
    return { color: first.color, alpha: first.alpha ?? 1 };
  }
  const last = sorted[sorted.length - 1]!;
  if (clamped >= last.offset) {
    return { color: last.color, alpha: last.alpha ?? 1 };
  }
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (clamped >= a.offset && clamped <= b.offset) {
      const span = b.offset - a.offset;
      const f = span <= 0 ? 0 : (clamped - a.offset) / span;
      const ca = hexChannels(a.color);
      const cb = hexChannels(b.color);
      return {
        color: toHex([
          ca[0] + (cb[0] - ca[0]) * f,
          ca[1] + (cb[1] - ca[1]) * f,
          ca[2] + (cb[2] - ca[2]) * f,
        ]),
        alpha: (a.alpha ?? 1) + ((b.alpha ?? 1) - (a.alpha ?? 1)) * f,
      };
    }
  }
  return { color: last.color, alpha: last.alpha ?? 1 };
}

function sortedStops(stops: GradientStop[]): GradientStop[] {
  return [...stops].sort((a, b) => a.offset - b.offset);
}

/**
 * Insert a stop at `offset` with the interpolated colour there. Returns
 * the new paint plus the inserted stop's index in the sorted list.
 */
export function withStopAdded<P extends GradientPaint>(
  paint: P,
  offset: number,
): { paint: P; index: number } {
  const t = clamp01(offset);
  const sample = sampleStops(paint.stops, t);
  const stop: GradientStop = {
    offset: t,
    color: sample.color,
    ...(sample.alpha !== 1 ? { alpha: sample.alpha } : {}),
  };
  const stops = sortedStops([...paint.stops, stop]);
  return { paint: { ...paint, stops }, index: stops.indexOf(stop) };
}

/** Remove the stop at `index`; refuses to go below two stops. */
export function withStopRemoved<P extends GradientPaint>(
  paint: P,
  index: number,
): P | null {
  if (paint.stops.length <= 2 || !paint.stops[index]) {
    return null;
  }
  return { ...paint, stops: paint.stops.filter((_, i) => i !== index) };
}

/**
 * Move the stop at `index` to `offset`, keeping the list sorted.
 * Returns the paint plus the stop's index after the re-sort.
 */
export function withStopMoved<P extends GradientPaint>(
  paint: P,
  index: number,
  offset: number,
): { paint: P; index: number } | null {
  const existing = paint.stops[index];
  if (!existing) {
    return null;
  }
  const moved: GradientStop = { ...existing, offset: clamp01(offset) };
  const stops = sortedStops(
    paint.stops.map((stop, i) => (i === index ? moved : stop)),
  );
  return { paint: { ...paint, stops }, index: stops.indexOf(moved) };
}

/** Patch one stop's colour and/or alpha in place. */
export function withStopPatched<P extends GradientPaint>(
  paint: P,
  index: number,
  patch: { color?: string; alpha?: number },
): P | null {
  const existing = paint.stops[index];
  if (!existing) {
    return null;
  }
  const next: GradientStop = { ...existing, ...patch };
  if (next.alpha !== undefined && next.alpha >= 1) {
    delete next.alpha;
  }
  return {
    ...paint,
    stops: paint.stops.map((stop, i) => (i === index ? next : stop)),
  };
}

/** Default 2-stop linear gradient seeded from a solid colour. */
export function defaultLinearGradient(color: string): LinearGradientPaint {
  return {
    type: "linear-gradient",
    angle: 90,
    stops: [
      { offset: 0, color },
      { offset: 1, color: "#4f6bf6" },
    ],
  };
}

/** Default centred radial gradient seeded from a solid colour. */
export function defaultRadialGradient(color: string): RadialGradientPaint {
  return {
    type: "radial-gradient",
    cx: 0.5,
    cy: 0.5,
    r: 0.5,
    stops: [
      { offset: 0, color },
      { offset: 1, color: "#4f6bf6" },
    ],
  };
}

/**
 * Convert a paint between solid / linear / radial, preserving stops (or
 * seeding them from the solid colour) so switching type in the UI never
 * loses the user's colour work.
 */
export function convertPaint(
  paint: Paint,
  to: Paint["type"],
): Paint {
  if (paint.type === to) {
    return paint;
  }
  if (to === "solid") {
    return {
      type: "solid",
      color: paint.type === "solid" ? paint.color : (paint.stops[0]?.color ?? "#111827"),
    };
  }
  const stops: GradientStop[] =
    paint.type === "solid"
      ? [
          { offset: 0, color: paint.color },
          { offset: 1, color: "#4f6bf6" },
        ]
      : paint.stops;
  if (to === "linear-gradient") {
    return { type: "linear-gradient", angle: 90, stops };
  }
  return { type: "radial-gradient", cx: 0.5, cy: 0.5, r: 0.5, stops };
}
