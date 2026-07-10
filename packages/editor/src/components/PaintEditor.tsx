import { useEffect, useId, useRef, useState } from "react";
import {
  type GradientStop,
  type Paint,
  convertPaint,
  isGradient,
  withStopAdded,
  withStopMoved,
  withStopPatched,
  withStopRemoved,
} from "@openlogo/core";
import { Plus, Trash2 } from "lucide-react";
import { ColorInfoChip } from "./ColorInfo";

/**
 * Paint editor shared by fill and stroke: solid / linear / radial
 * toggle, and for gradients a full stop editor — click the ramp to add
 * a stop, drag a chip to reposition (previewed, committed once on
 * release), per-stop colour + alpha, remove (min two stops).
 */

const FILL_SWATCH =
  "fill-swatch h-32 w-32 flex-none cursor-pointer rounded-field border border-field-border bg-transparent p-2";

function stopColor(stop: GradientStop): string {
  const alpha = stop.alpha ?? 1;
  if (alpha >= 1) {
    return stop.color;
  }
  const hex = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
  return `${stop.color}${hex}`;
}

function rampBackground(stops: GradientStop[]): string {
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  return `linear-gradient(90deg, ${sorted
    .map((stop) => `${stopColor(stop)} ${stop.offset * 100}%`)
    .join(", ")})`;
}

/** CSS preview used by paint controls and compact inspector swatches. */
export function paintPreviewBackground(paint: Paint): string {
  if (paint.type === "solid") {
    return paint.color;
  }
  const stops = [...paint.stops]
    .sort((a, b) => a.offset - b.offset)
    .map((stop) => `${stopColor(stop)} ${stop.offset * 100}%`)
    .join(", ");
  return paint.type === "radial-gradient"
    ? `radial-gradient(circle, ${stops})`
    : `linear-gradient(${paint.angle + 90}deg, ${stops})`;
}

/** Midpoint of the largest empty interval: predictable keyboard stop add. */
export function nextGradientStopOffset(stops: GradientStop[]): number {
  const offsets = [0, ...stops.map((stop) => stop.offset), 1].sort(
    (a, b) => a - b,
  );
  let bestStart = 0;
  let bestEnd = 0;
  for (let index = 1; index < offsets.length; index += 1) {
    const start = offsets[index - 1]!;
    const end = offsets[index]!;
    if (end - start > bestEnd - bestStart) {
      bestStart = start;
      bestEnd = end;
    }
  }
  return (bestStart + bestEnd) / 2;
}

/** Numeric input that commits on blur/Enter (compact, unlabeled). */
function SmallNumber({
  value,
  onCommit,
  ariaLabel,
  prefix,
  min,
  max,
  step = 1,
  suffix,
}: {
  value: number;
  onCommit: (value: number) => void;
  ariaLabel: string;
  prefix?: string;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <label className="flex h-30 min-w-0 flex-1 items-center gap-5 rounded-field border border-field-border bg-field px-7 text-[10.5px] text-ink-dim transition-[border-color,background-color,box-shadow] focus-within:border-accent focus-within:bg-card focus-within:shadow-ring">
      {prefix && (
        <span className="flex-none font-[600] text-ink-dim">{prefix}</span>
      )}
      <input
        type="number"
        className="w-full min-w-0 border-0 bg-transparent p-0 text-right text-[11.5px] tabular-nums text-ink outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        value={draft}
        step={step}
        min={min}
        max={max}
        aria-label={ariaLabel}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          let parsed = Number(draft);
          if (!Number.isFinite(parsed)) {
            setDraft(String(value));
            return;
          }
          if (min !== undefined) parsed = Math.max(min, parsed);
          if (max !== undefined) parsed = Math.min(max, parsed);
          if (parsed !== value) {
            onCommit(parsed);
          } else {
            setDraft(String(value));
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            (event.target as HTMLInputElement).blur();
          } else if (event.key === "Escape") {
            setDraft(String(value));
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
      {suffix && <span>{suffix}</span>}
    </label>
  );
}

function HexColorField({
  value,
  ariaLabel,
  onCommit,
}: {
  value: string;
  ariaLabel: string;
  onCommit: (value: string) => void;
}) {
  const normalized = value.toUpperCase();
  const [draft, setDraft] = useState(normalized);

  useEffect(() => setDraft(normalized), [normalized]);

  const commit = () => {
    const candidate = draft.trim();
    const withHash = candidate.startsWith("#") ? candidate : `#${candidate}`;
    if (/^#[0-9a-fA-F]{6}$/.test(withHash)) {
      const next = withHash.toUpperCase();
      setDraft(next);
      if (next !== normalized) {
        onCommit(next);
      }
    } else {
      setDraft(normalized);
    }
  };

  return (
    <input
      className="fill-hex h-32 min-w-0 flex-1 rounded-field border border-field-border bg-field px-9 text-[11.5px] uppercase tabular-nums outline-none transition-[border-color,background-color,box-shadow] duration-140 ease-studio focus:border-accent focus:bg-card focus:shadow-ring"
      value={draft}
      maxLength={7}
      spellCheck={false}
      aria-label={ariaLabel}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setDraft(normalized);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function PaintEditor({
  paint,
  label,
  onCommit,
  onPreview,
  onCancelPreview,
}: {
  paint: Paint;
  /** Aria prefix, e.g. "Fill" / "Stroke". */
  label: string;
  /** Persistent change (one history entry). */
  onCommit: (paint: Paint) => void;
  /** Transient change during a chip drag; commit follows on release. */
  onPreview: (paint: Paint) => void;
  /** Restore the committed paint when a pointer gesture is interrupted. */
  onCancelPreview: () => void;
}) {
  const [selectedStop, setSelectedStop] = useState(0);
  const [previewPaint, setPreviewPaint] = useState<Paint | null>(null);
  const rampId = useId();
  const rampRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    index: number;
    paint: Paint;
    moved: boolean;
  } | null>(null);

  // Keep the moving chip/ramp local to this small subtree. The document
  // preview updates CanvasKit directly; no inspector-wide live subscription.
  const displayedPaint = previewPaint ?? paint;
  const gradient = isGradient(displayedPaint) ? displayedPaint : null;
  const stopIndex = gradient
    ? Math.min(selectedStop, gradient.stops.length - 1)
    : 0;
  const stop = gradient?.stops[stopIndex];
  const solidColor =
    displayedPaint.type === "solid" ? displayedPaint.color : "#000000";

  const finishDrag = (commit: boolean) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setPreviewPaint(null);
    if (!drag?.moved) {
      return;
    }
    if (commit) {
      onCommit(drag.paint);
    } else {
      onCancelPreview();
    }
  };

  const toggleButton =
    "min-h-28 flex-1 rounded-[6px] py-4 text-[11.5px] transition-[background-color,color,box-shadow] duration-120 ease-studio";
  const toggleActive =
    "bg-card font-semibold text-ink shadow-[0_1px_2px_rgb(28_25_33/0.1)]";

  const offsetFromEvent = (event: React.PointerEvent): number => {
    const rect = rampRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  };

  const addStop = (offset: number) => {
    if (!gradient) {
      return;
    }
    const added = withStopAdded(gradient, offset);
    setSelectedStop(added.index);
    onCommit(added.paint);
  };

  return (
    <div className="paint-editor">
      <div
        className="mb-12 flex gap-2 rounded-m border border-field-border bg-field p-2"
        role="group"
        aria-label={`${label} type`}
      >
        {(
          [
            ["solid", "Solid"],
            ["linear-gradient", "Linear"],
            ["radial-gradient", "Radial"],
          ] as const
        ).map(([type, name]) => (
          <button
            key={type}
            type="button"
            data-paint-type={type}
            className={`${toggleButton} ${
              displayedPaint.type === type
                ? `active ${toggleActive}`
                : "text-ink-dim"
            }`}
            aria-pressed={displayedPaint.type === type}
            onClick={() => {
              if (displayedPaint.type !== type) {
                onCommit(convertPaint(displayedPaint, type));
              }
            }}
          >
            {name}
          </button>
        ))}
      </div>

      {gradient ? (
        <div>
          <div className="mb-8 flex items-center justify-between gap-8">
            <span className="text-[10.5px] font-[600] text-ink-dim">
              Gradient stops
              <span className="ml-5 font-normal tabular-nums text-ink-dim">
                {gradient.stops.length}
              </span>
            </span>
            <button
              type="button"
              className="inline-flex h-26 items-center gap-4 rounded-field border border-field-border bg-card px-7 text-[10.5px] text-ink-dim transition-[border-color,color] duration-140 ease-studio hover:border-accent hover:text-accent"
              aria-controls={rampId}
              onClick={() => addStop(nextGradientStopOffset(gradient.stops))}
            >
              <Plus size={11} strokeWidth={2} /> Add stop
            </button>
          </div>
          {/* The ramp: click adds a stop, chips drag to reposition. */}
          <div
            ref={rampRef}
            id={rampId}
            data-testid="gradient-ramp"
            className="relative mb-18 h-18 cursor-crosshair rounded-[7px] border border-[rgb(28_25_33/0.14)] shadow-[inset_0_1px_2px_rgb(28_25_33/0.08)]"
            style={{ background: rampBackground(gradient.stops) }}
            role="group"
            aria-label={`${label} gradient stops`}
            title="Click to add a gradient stop"
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).dataset.stopChip) {
                return; // chip drags handle themselves
              }
              addStop(offsetFromEvent(event));
            }}
          >
            {gradient.stops.map((item, index) => (
              <button
                key={index}
                type="button"
                data-stop-chip={index}
                data-selected={index === stopIndex || undefined}
                className="absolute top-[10px] grid h-26 w-26 -translate-x-1/2 cursor-ew-resize place-items-center rounded-full"
                style={{ left: `${item.offset * 100}%` }}
                aria-label={`${label} gradient stop ${index + 1}, ${Math.round(
                  item.offset * 100,
                )} percent`}
                aria-pressed={index === stopIndex}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedStop(index);
                    return;
                  }
                  const delta = event.shiftKey ? 0.1 : 0.01;
                  const nextOffset =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? 1
                        : event.key === "ArrowLeft" || event.key === "ArrowDown"
                          ? item.offset - delta
                          : event.key === "ArrowRight" || event.key === "ArrowUp"
                            ? item.offset + delta
                            : null;
                  if (nextOffset === null) {
                    return;
                  }
                  event.preventDefault();
                  const moved = withStopMoved(
                    gradient,
                    index,
                    Math.min(1, Math.max(0, nextOffset)),
                  );
                  if (moved) {
                    setSelectedStop(moved.index);
                    onCommit(moved.paint);
                  }
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setSelectedStop(index);
                  setPreviewPaint(null);
                  dragRef.current = { index, paint: gradient, moved: false };
                }}
                onPointerMove={(event) => {
                  const drag = dragRef.current;
                  if (!drag || !isGradient(drag.paint)) {
                    return;
                  }
                  const moved = withStopMoved(
                    drag.paint as typeof gradient,
                    drag.index,
                    offsetFromEvent(event),
                  );
                  if (moved) {
                    drag.paint = moved.paint;
                    drag.index = moved.index;
                    drag.moved = true;
                    setSelectedStop(moved.index);
                    setPreviewPaint(moved.paint);
                    onPreview(moved.paint);
                  }
                }}
                onPointerUp={() => finishDrag(true)}
                onPointerCancel={() => finishDrag(false)}
                onLostPointerCapture={() => finishDrag(false)}
              >
                <span
                  className={`h-15 w-15 rounded-full border-2 shadow-[0_1px_3px_rgb(28_25_33/0.32)] ${
                    index === stopIndex
                      ? "border-accent ring-2 ring-white"
                      : "border-white"
                  }`}
                  style={{ background: item.color }}
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>

          {stop && (
            <div className="mb-10 grid gap-7 rounded-m border border-field-border bg-[rgb(241_239_236/0.56)] p-7">
              <div className="flex min-w-0 items-center gap-6">
                <input
                  type="color"
                  className={FILL_SWATCH}
                  value={stop.color}
                  aria-label={`${label} stop color`}
                  onChange={(event) => {
                    const next = withStopPatched(gradient, stopIndex, {
                      color: event.target.value,
                    });
                    if (next) {
                      onCommit(next);
                    }
                  }}
                />
                <HexColorField
                  value={stop.color}
                  ariaLabel={`${label} stop hex`}
                  onCommit={(color) => {
                    const next = withStopPatched(gradient, stopIndex, { color });
                    if (next) {
                      onCommit(next);
                    }
                  }}
                />
                <ColorInfoChip color={stop.color} />
                <button
                  type="button"
                  className="grid h-28 w-28 flex-none cursor-pointer place-items-center rounded-field border border-field-border bg-card text-ink-dim transition-[border-color,color] duration-140 ease-studio hover:enabled:border-danger hover:enabled:text-danger disabled:cursor-not-allowed disabled:opacity-35"
                  disabled={gradient.stops.length <= 2}
                  title="Remove stop"
                  aria-label={`Remove ${label.toLowerCase()} stop`}
                  onClick={() => {
                    const next = withStopRemoved(gradient, stopIndex);
                    if (next) {
                      setSelectedStop(Math.max(0, stopIndex - 1));
                      onCommit(next);
                    }
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="flex min-w-0 gap-6">
                <SmallNumber
                  prefix="Opacity"
                  value={Math.round((stop.alpha ?? 1) * 100)}
                  min={0}
                  max={100}
                  step={5}
                  suffix="%"
                  ariaLabel={`${label} stop alpha`}
                  onCommit={(percent) => {
                    const next = withStopPatched(gradient, stopIndex, {
                      alpha: percent / 100,
                    });
                    if (next) {
                      onCommit(next);
                    }
                  }}
                />
                <SmallNumber
                  prefix="Location"
                  value={Math.round(stop.offset * 100)}
                  min={0}
                  max={100}
                  step={1}
                  suffix="%"
                  ariaLabel={`${label} stop position`}
                  onCommit={(percent) => {
                    const moved = withStopMoved(
                      gradient,
                      stopIndex,
                      percent / 100,
                    );
                    if (moved) {
                      setSelectedStop(moved.index);
                      onCommit(moved.paint);
                    }
                  }}
                />
              </div>
            </div>
          )}

          {gradient.type === "linear-gradient" ? (
            <div className="flex items-center gap-6">
              <SmallNumber
                prefix="Angle"
                value={Math.round(gradient.angle)}
                step={15}
                suffix="°"
                ariaLabel={`${label} gradient angle`}
                onCommit={(angle) => {
                  // Editing the angle re-derives the line: explicit
                  // annotator endpoints would silently win otherwise.
                  const { start: _s, end: _e, ...rest } = gradient;
                  onCommit({ ...rest, angle });
                }}
              />
              <span className="text-[10.5px] leading-[1.35] text-ink-dim">
                Press <kbd>G</kbd> to edit on canvas
              </span>
            </div>
          ) : (
            <label className="flex cursor-pointer items-center gap-6 text-[11.5px] text-ink-dim">
              <input
                type="checkbox"
                checked={gradient.fx !== undefined}
                aria-label="Focal point"
                onChange={(event) => {
                  if (event.target.checked) {
                    onCommit({
                      ...gradient,
                      fx: gradient.cx - gradient.r / 2,
                      fy: gradient.cy,
                    });
                  } else {
                    const { fx: _fx, fy: _fy, ...rest } = gradient;
                    onCommit(rest);
                  }
                }}
              />
              Focal point · press G to edit on canvas
            </label>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-7">
          <input
            type="color"
            className={FILL_SWATCH}
            value={solidColor}
            onChange={(event) =>
              onCommit({ type: "solid", color: event.target.value })
            }
            aria-label={`${label} color`}
          />
          <HexColorField
            value={solidColor}
            ariaLabel={`${label} hex`}
            onCommit={(color) => onCommit({ type: "solid", color })}
          />
          <ColorInfoChip color={solidColor} />
        </div>
      )}
    </div>
  );
}
