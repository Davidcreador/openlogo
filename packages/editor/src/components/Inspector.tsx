import {
  memo,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
// Aliased: this file already imports the domain `Effect` (layer effect) type.
import { Effect as Fx } from "effect";
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceBetween,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceBetween,
  ChevronDown,
  ChevronRight,
  Circle,
  Crop,
  Eye,
  EyeOff,
  FlipHorizontal2,
  FlipVertical2,
  Folder,
  Layers3,
  Lock,
  PenTool,
  RotateCw,
  Shapes,
  SlidersHorizontal,
  Spline,
  Square,
  Type,
  Unlock,
} from "lucide-react";
import {
  DEFAULT_POLYGON_SIDES,
  DEFAULT_STAR_INNER_RATIO,
  DEFAULT_STAR_POINTS,
  type Effect,
  type GroupNode,
  type LogoDocument,
  type LogoNode,
  type NodePatch,
  type Paint,
  type Stroke,
  type TextNode,
  collectLeafNodeIds,
  findContainerId,
  getClippingMaskOwnerId,
  getContainerChildIds,
  kernedPairCount,
  shapeDisplayName,
  shapeParamsPatch,
  unitBounds,
} from "@openlogo/core";
import {
  catalogEntry,
  nearestStyle,
  nearestWeight,
} from "../lib/font-catalog";
import { fontStore } from "../lib/font-store";
import { FontPicker } from "./FontPicker";
import { PaintEditor, paintPreviewBackground } from "./PaintEditor";
import {
  moveUnitToContainer,
  rotateUnitBy,
  setUnitBounds,
  ungroupSelection,
} from "../lib/group-ops";
import {
  alignNodes,
  distributeNodes,
  distributeNodesSpacing,
  expandStrokeOp,
  flipNodes,
  rotateCopies,
} from "../lib/object-ops";
import { colorInfo } from "../lib/color-info";
import { releaseClippingMask } from "../lib/clipping-mask";
import { nodeToPreviewSvg } from "../lib/export";
import { offsetPathOp } from "../lib/offset-path";
import { editSwatch } from "../lib/swatches";
import {
  attachTextToPath,
  detachTextFromPath,
  isTextPathPair,
  pathNodeLength,
} from "../lib/text-on-path";
import { convertTextToPath } from "../lib/text-to-path";
import { documentStore, useDocument } from "../state/document";
import { useEditorStore } from "../state/editor-store";

const WEIGHT_LABELS: Record<number, string> = {
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extra bold",
  900: "Black",
};

const NODE_ICONS = {
  rectangle: Square,
  ellipse: Circle,
  path: PenTool,
  text: Type,
  group: Folder,
} as const;

/* Recurring utility recipes. Each section is its own card on the panel's
   paper background; fields share the warm sunken look with an accent
   focus ring. */
const SECTION =
  "inspector-section shrink-0 rounded-[12px] border border-panel-hairline bg-card p-14 shadow-section";
const SECTION_HEAD = "section-head mb-12 flex min-h-22 items-center justify-between gap-8";
const SECTION_H2 =
  "m-0 text-[11px] font-[680] uppercase tracking-[0.075em] text-ink-dim";
const SECTION_META = "section-meta min-w-0 flex-none max-w-[55%] truncate text-[11px] tabular-nums text-ink-dim";
const MUTED = "m-0 text-[12px] leading-[1.5] text-ink-dim";
const FIELD_GRID = "grid grid-cols-2 gap-7";
const FIELD_ROW = "flex gap-6";
const FILL_ROW = "mb-10 flex items-center gap-6";
const FILL_SWATCH =
  "fill-swatch h-28 w-28 flex-none cursor-pointer rounded-field border border-field-border bg-transparent p-2";
const OPACITY_FIELD = "flex min-w-0 flex-1 items-center gap-6";
const SWATCH =
  "h-24 w-24 cursor-pointer rounded-[7px] border border-[rgb(var(--edge-rgb)_/_0.1)] shadow-[inset_0_1px_0_rgb(255_255_255/0.12)] transition-[transform,box-shadow] duration-140 ease-studio hover:-translate-y-1 hover:scale-[1.08] hover:shadow-[0_2px_6px_var(--shade-swatch-hover)]";
const STROKE_HEAD =
  "mb-6 flex items-center justify-between text-[11px] font-[650] uppercase tracking-[0.06em] text-ink-dim";
const STROKE_TOGGLE_BASE =
  "inline-flex items-center gap-5 rounded-field border bg-card px-9 py-4 text-[11.5px] transition-[border-color,color] duration-140 ease-studio";

const STROKE_TOGGLE = `${STROKE_TOGGLE_BASE} border-field-border text-ink-dim hover:border-accent hover:text-accent`;
const STROKE_TOGGLE_ACTIVE = `${STROKE_TOGGLE_BASE} border-accent text-accent`;
const SELECT =
  "ui-select h-32 rounded-field border border-field-border bg-field px-8 text-[12px] text-ink outline-none transition-[border-color,box-shadow] duration-140 ease-studio focus:border-accent focus:bg-card focus:shadow-ring";
const TEXT_INPUT =
  "h-32 rounded-field border border-field-border bg-field px-8 text-[12.5px] text-ink outline-none transition-[border-color,box-shadow] duration-140 ease-studio focus:border-accent focus:bg-card focus:shadow-ring";
const OUTLINE_BUTTON =
  "w-full rounded-field border border-dashed border-[rgb(var(--edge-rgb)_/_0.22)] bg-transparent px-10 py-7 text-[12px] text-ink-dim transition-[border-color,color] duration-140 ease-studio hover:enabled:border-accent hover:enabled:text-accent disabled:cursor-not-allowed disabled:opacity-50";

function PanelSection({
  title,
  meta,
  action,
  defaultOpen = true,
  children,
}: {
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();

  return (
    <section className={SECTION}>
      <header className={`${SECTION_HEAD}${open ? "" : " mb-0"}`}>
        <button
          type="button"
          className="group flex min-w-0 flex-1 items-center gap-7 text-left"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((value) => !value)}
        >
          <span
            className={`grid h-18 w-18 flex-none place-items-center rounded-[5px] text-ink-dim transition-[transform,background-color,color] duration-140 ease-studio group-hover:bg-field group-hover:text-ink ${
              open ? "rotate-90" : ""
            }`}
            aria-hidden="true"
          >
            <ChevronRight size={12} strokeWidth={2} />
          </span>
          <h2 className={`${SECTION_H2} truncate`}>{title}</h2>
        </button>
        {action ?? (meta ? <span className={SECTION_META}>{meta}</span> : null)}
      </header>
      <div id={contentId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}

/**
 * Numeric field that commits on blur/Enter and follows external changes.
 * The label doubles as a scrubber: drag horizontally to adjust, committing
 * once on release so history gets a single entry.
 */
function NumberField({
  label,
  ariaLabel,
  value,
  onCommit,
  step = 1,
  unit,
}: {
  label: string;
  ariaLabel?: string;
  value: number;
  onCommit: (value: number) => void;
  step?: number;
  unit?: string;
}) {
  const [draft, setDraft] = useState(String(Math.round(value * 100) / 100));
  const scrubRef = useRef<{ startX: number; active: boolean } | null>(null);

  useEffect(() => {
    setDraft(String(Math.round(value * 100) / 100));
  }, [value]);

  function commitNumber(parsed: number) {
    if (Number.isFinite(parsed) && parsed !== value) {
      onCommit(parsed);
    } else {
      setDraft(String(Math.round(value * 100) / 100));
    }
  }

  // Scrubbing always starts from the committed value: 3px per step.
  function scrubbedValue(event: React.PointerEvent): number {
    const scrub = scrubRef.current!;
    const raw = value + Math.round((event.clientX - scrub.startX) / 3) * step;
    return Math.round(raw * 100) / 100;
  }

  return (
    <label className="number-field">
      <span
        className="nf-label"
        title="Drag to adjust"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          scrubRef.current = { startX: event.clientX, active: false };
        }}
        onPointerMove={(event) => {
          const scrub = scrubRef.current;
          if (!scrub) {
            return;
          }
          if (!scrub.active && Math.abs(event.clientX - scrub.startX) < 3) {
            return;
          }
          scrub.active = true;
          setDraft(String(scrubbedValue(event)));
        }}
        onPointerUp={(event) => {
          const scrub = scrubRef.current;
          scrubRef.current = null;
          if (scrub?.active) {
            commitNumber(scrubbedValue(event));
          }
        }}
        onPointerCancel={() => {
          scrubRef.current = null;
          setDraft(String(Math.round(value * 100) / 100));
        }}
      >
        {label}
      </span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        aria-label={ariaLabel ?? label}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => commitNumber(Number(draft.replace(",", ".")))}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            (event.target as HTMLInputElement).blur();
          } else if (event.key === "Escape") {
            setDraft(String(Math.round(value * 100) / 100));
            (event.target as HTMLInputElement).blur();
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            const current = Number(draft.replace(",", "."));
            const base = Number.isFinite(current) ? current : value;
            const delta =
              (event.key === "ArrowUp" ? 1 : -1) *
              (event.shiftKey ? step * 10 : step);
            const next = Math.round((base + delta) * 100) / 100;
            setDraft(String(next));
            commitNumber(next);
          }
        }}
      />
      {unit && <span className="nf-unit">{unit}</span>}
    </label>
  );
}

function OpacityField({
  value,
  ariaLabel = "Opacity",
  onPreview,
  onCommit,
  onCancel,
}: {
  value: number;
  ariaLabel?: string;
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [percentDraft, setPercentDraft] = useState(
    String(Math.round(value * 100)),
  );
  const draftRef = useRef(value);
  const activeRef = useRef(false);

  useEffect(() => {
    if (!activeRef.current) {
      draftRef.current = value;
      setDraft(value);
      setPercentDraft(String(Math.round(value * 100)));
    }
  }, [value]);
  useEffect(
    () => () => {
      if (activeRef.current) {
        onCancel();
      }
    },
    // The cancel callback is an imperative document-store boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const preview = (next: number) => {
    const bounded = Math.min(1, Math.max(0, next));
    activeRef.current = true;
    draftRef.current = bounded;
    setDraft(bounded);
    setPercentDraft(String(Math.round(bounded * 100)));
    onPreview(bounded);
  };

  const finish = (commit: boolean) => {
    if (!activeRef.current) {
      return;
    }
    activeRef.current = false;
    if (commit && draftRef.current !== value) {
      onCommit(draftRef.current);
    } else {
      draftRef.current = value;
      setDraft(value);
      setPercentDraft(String(Math.round(value * 100)));
      onCancel();
    }
  };

  return (
    <>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        className="inspector-range min-w-0 flex-1"
        value={draft}
        style={{ "--range-progress": draft } as React.CSSProperties}
        onPointerDown={(event) => {
          activeRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onChange={(event) => preview(Number(event.target.value))}
        onPointerUp={() => finish(true)}
        onPointerCancel={() => finish(false)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            finish(false);
            event.currentTarget.blur();
          }
        }}
        aria-label={ariaLabel}
      />
      <label className="flex h-28 w-58 flex-none items-center rounded-field border border-field-border bg-field px-6 text-[10.5px] text-ink-dim transition-[border-color,background-color,box-shadow] focus-within:border-accent focus-within:bg-card focus-within:shadow-ring">
        <input
          type="number"
          min="0"
          max="100"
          step="1"
          className="w-full min-w-0 border-0 bg-transparent p-0 text-right text-[11.5px] tabular-nums text-ink outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          value={percentDraft}
          aria-label={`${ariaLabel} percent`}
          onChange={(event) => {
            const next = event.target.value;
            setPercentDraft(next);
            if (next.trim() !== "") {
              const parsed = Number(next);
              if (Number.isFinite(parsed)) {
                preview(parsed / 100);
              }
            }
          }}
          onBlur={() => {
            if (percentDraft.trim() === "") {
              setPercentDraft(String(Math.round(value * 100)));
            }
            finish(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              finish(false);
              event.currentTarget.blur();
            }
          }}
        />
        <span aria-hidden="true">%</span>
      </label>
    </>
  );
}

function TextContentField({
  value,
  onPreview,
  onCommit,
  onCancel,
}: {
  value: string;
  onPreview: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const activeRef = useRef(false);
  const draftRef = useRef(value);

  useEffect(() => {
    if (!activeRef.current) {
      draftRef.current = value;
      setDraft(value);
    }
  }, [value]);
  useEffect(
    () => () => {
      if (activeRef.current) {
        onCancel();
      }
    },
    // See OpacityField: cancel any transient preview when selection unmounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const finish = (commit: boolean) => {
    if (!activeRef.current) {
      return;
    }
    activeRef.current = false;
    if (commit && draftRef.current !== value) {
      onCommit(draftRef.current);
    } else {
      draftRef.current = value;
      setDraft(value);
      onCancel();
    }
  };

  return (
    <input
      className={TEXT_INPUT}
      value={draft}
      onFocus={() => {
        activeRef.current = true;
      }}
      onChange={(event) => {
        const next = event.target.value;
        activeRef.current = true;
        draftRef.current = next;
        setDraft(next);
        onPreview(next);
      }}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function AlignPanel({ nodeIds }: { nodeIds: readonly string[] }) {
  const canDistribute = nodeIds.length >= 3;
  const setTransformDialogOpen = useEditorStore(
    (state) => state.setTransformDialogOpen,
  );
  // Key object (clicked again on canvas): align targets it, spacing
  // anchors on it. Only honoured while it's part of this selection.
  const keyObjectId = useEditorStore((state) => state.keyObjectId);
  const keyId =
    keyObjectId && nodeIds.length > 1 && nodeIds.includes(keyObjectId)
      ? keyObjectId
      : null;
  const [spacingDraft, setSpacingDraft] = useState("20");
  const canSpace = nodeIds.length >= 2;

  function distributeSpacing(axis: "horizontal" | "vertical") {
    const spacing = Number(spacingDraft.replace(",", "."));
    if (Number.isFinite(spacing)) {
      distributeNodesSpacing(nodeIds, axis, spacing, keyId);
    }
  }

  const alignButtons = [
    { edge: "left", icon: AlignStartVertical, label: "Align left" },
    { edge: "centerX", icon: AlignCenterVertical, label: "Align center" },
    { edge: "right", icon: AlignEndVertical, label: "Align right" },
    { edge: "top", icon: AlignStartHorizontal, label: "Align top" },
    { edge: "centerY", icon: AlignCenterHorizontal, label: "Align middle" },
    { edge: "bottom", icon: AlignEndHorizontal, label: "Align bottom" },
  ] as const;

  const button =
    "grid h-24 place-items-center rounded-[5px] text-ink-dim transition-[background-color,color,box-shadow] duration-120 ease-studio hover:enabled:bg-card hover:enabled:text-ink hover:enabled:shadow-tab disabled:cursor-default disabled:opacity-25";

  return (
    <>
    <div
      className="mb-6 grid grid-cols-5 gap-2 rounded-m border border-field-border bg-field p-3"
      role="group"
      aria-label="Align and distribute"
    >
      {alignButtons.map(({ edge, icon: Icon, label }) => (
        <button
          key={edge}
          type="button"
          className={button}
          title={keyId ? `${label} (to key object)` : label}
          aria-label={label}
          onClick={() => alignNodes(nodeIds, edge, keyId)}
        >
          <Icon size={14} />
        </button>
      ))}
      <button
        type="button"
        className={button}
        title="Distribute horizontally"
        aria-label="Distribute horizontally"
        disabled={!canDistribute}
        onClick={() => distributeNodes(nodeIds, "horizontal")}
      >
        <AlignHorizontalSpaceBetween size={14} />
      </button>
      <button
        type="button"
        className={button}
        title="Distribute vertically"
        aria-label="Distribute vertically"
        disabled={!canDistribute}
        onClick={() => distributeNodes(nodeIds, "vertical")}
      >
        <AlignVerticalSpaceBetween size={14} />
      </button>
      <button
        type="button"
        className={button}
        title="Flip horizontal"
        aria-label="Flip horizontal"
        onClick={() => flipNodes(nodeIds, "horizontal")}
      >
        <FlipHorizontal2 size={14} />
      </button>
      <button
        type="button"
        className={button}
        title="Flip vertical"
        aria-label="Flip vertical"
        onClick={() => flipNodes(nodeIds, "vertical")}
      >
        <FlipVertical2 size={14} />
      </button>
      <button
        type="button"
        className={button}
        title="Rotate / reflect…"
        aria-label="Rotate or reflect"
        onClick={() => setTransformDialogOpen(true)}
      >
        <RotateCw size={14} />
      </button>
    </div>
    <div
      className="mb-10 flex items-center gap-4 rounded-m border border-field-border bg-field p-3"
      role="group"
      aria-label="Distribute spacing"
    >
      <input
        type="text"
        inputMode="decimal"
        className="h-24 w-52 min-w-0 rounded-[5px] border border-field-border bg-card px-6 text-[11.5px] tabular-nums text-ink outline-none focus:border-accent"
        value={spacingDraft}
        onChange={(event) => setSpacingDraft(event.target.value)}
        aria-label="Distribution spacing"
        title="Gap between objects, px"
      />
      <span className="text-[10px] text-ink-dim">px</span>
      <button
        type="button"
        className={`${button} h-24 flex-1`}
        title={`Distribute horizontal spacing${keyId ? " (anchor: key object)" : ""}`}
        aria-label="Distribute horizontal spacing"
        disabled={!canSpace}
        onClick={() => distributeSpacing("horizontal")}
      >
        <AlignHorizontalSpaceBetween size={13} />
      </button>
      <button
        type="button"
        className={`${button} h-24 flex-1`}
        title={`Distribute vertical spacing${keyId ? " (anchor: key object)" : ""}`}
        aria-label="Distribute vertical spacing"
        disabled={!canSpace}
        onClick={() => distributeSpacing("vertical")}
      >
        <AlignVerticalSpaceBetween size={13} />
      </button>
    </div>
    </>
  );
}

function FillEditor({
  node,
  patchSelection,
  previewSelection,
  cancelPreview,
}: {
  node: LogoNode;
  patchSelection: (patch: NodePatch) => void;
  previewSelection: (patch: NodePatch) => void;
  cancelPreview: () => void;
}) {
  return (
    <>
      <PaintEditor
        paint={node.fill}
        label="Fill"
        onCommit={(fill) => patchSelection({ fill })}
        onPreview={(fill) => previewSelection({ fill })}
        onCancelPreview={cancelPreview}
      />
      <div className="mt-12 grid grid-cols-[54px_minmax(0,1fr)] items-center gap-8">
        <span className="text-[11px] font-[600] text-ink-dim">Opacity</span>
        <div className={OPACITY_FIELD}>
          <OpacityField
            value={node.opacity}
            onPreview={(opacity) => previewSelection({ opacity })}
            onCommit={(opacity) => patchSelection({ opacity })}
            onCancel={cancelPreview}
          />
        </div>
      </div>
    </>
  );
}

function StrokeEditor({
  node,
  patchSelection,
  previewSelection,
  cancelPreview,
}: {
  node: LogoNode;
  patchSelection: (patch: NodePatch) => void;
  previewSelection: (patch: NodePatch) => void;
  cancelPreview: () => void;
}) {
  const stroke = node.stroke;
  const [showPaint, setShowPaint] = useState(false);
  const paintEditorId = useId();
  const strokeIsGradient = Boolean(stroke?.paint && stroke.paint.type !== "solid");
  const strokePaint: Paint = stroke?.paint ?? {
    type: "solid",
    color: stroke?.color ?? "#111827",
  };

  // A gradient stroke edits through the shared PaintEditor; `color`
  // stays in sync with the first stop as the legacy/solid fallback.
  const strokeWithPaint = (paint: Paint): Stroke => {
    const { paint: _previous, ...rest } = stroke!;
    return paint.type === "solid"
      ? { ...rest, color: paint.color }
      : { ...rest, color: paint.stops[0]?.color ?? rest.color, paint };
  };

  const commitStrokePaint = (paint: Paint) => {
    if (stroke) {
      patchSelection({ stroke: strokeWithPaint(paint) });
    }
  };

  return (
    <PanelSection
      title="Stroke"
      action={
        <button
          type="button"
          className={STROKE_TOGGLE}
          aria-label={stroke ? "Remove stroke" : "Add stroke"}
          aria-pressed={Boolean(stroke)}
          onClick={() =>
            patchSelection({
              stroke: stroke
                ? undefined
                : { color: "#111827", width: 2, align: "center" },
            })
          }
        >
          {stroke ? "Remove" : "Add"}
        </button>
      }
    >
      {stroke && (
        <>
          <div className={FILL_ROW}>
            <button
              type="button"
              className="h-32 w-32 flex-none cursor-pointer rounded-field border border-field-border p-0 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.15)]"
              style={{ background: paintPreviewBackground(strokePaint) }}
              title="Stroke paint"
              aria-label="Stroke paint"
              aria-expanded={showPaint}
              aria-controls={paintEditorId}
              onClick={() => setShowPaint((value) => !value)}
            />
            <div className="min-w-0 flex-1">
              <NumberField
                label="W"
                ariaLabel="Stroke width"
                unit="px"
                value={stroke.width}
                step={0.5}
                onCommit={(width) =>
                  patchSelection({
                    stroke: { ...stroke, width: Math.max(0, width) },
                  })
                }
              />
            </div>
            {node.type !== "text" && (
              <button
                type="button"
                className={STROKE_TOGGLE}
                title="Outline stroke into a filled path"
                onClick={() => void expandStrokeOp(node.id)}
              >
                Expand
              </button>
            )}
          </div>
          <div className="mb-10 grid grid-cols-[54px_minmax(0,1fr)] items-center gap-8">
            <span className="text-[11px] font-[600] text-ink-dim">Align</span>
            <div
              className="grid h-30 grid-cols-3 gap-2 rounded-m border border-field-border bg-field p-2"
              role="group"
              aria-label="Stroke alignment"
            >
              {(["inside", "center", "outside"] as const).map((align) => (
                <button
                  key={align}
                  type="button"
                  className={`rounded-[5px] px-4 text-[10.5px] capitalize transition-[background-color,color,box-shadow] duration-120 ease-studio ${
                    stroke.align === align
                      ? "bg-card font-semibold text-ink shadow-tab"
                      : "text-ink-dim hover:text-ink"
                  }`}
                  aria-pressed={stroke.align === align}
                  onClick={() =>
                    patchSelection({ stroke: { ...stroke, align } })
                  }
                >
                  {align}
                </button>
              ))}
            </div>
          </div>
          {(showPaint || strokeIsGradient) && (
            <div
              id={paintEditorId}
              className="stroke-paint border-t border-panel-hairline pt-12"
            >
              <PaintEditor
                paint={strokePaint}
                label="Stroke"
                onCommit={commitStrokePaint}
                onPreview={(paint) =>
                  previewSelection({ stroke: strokeWithPaint(paint) })
                }
                onCancelPreview={cancelPreview}
              />
            </div>
          )}
        </>
      )}
    </PanelSection>
  );
}

function DesignSection({
  node,
  patchSelection,
  previewSelection,
  cancelPreview,
}: {
  node: LogoNode;
  patchSelection: (patch: NodePatch) => void;
  previewSelection: (patch: NodePatch) => void;
  cancelPreview: () => void;
}) {
  const document = useDocument();
  const setSelection = useEditorStore((state) => state.setSelection);
  const setToast = useEditorStore((state) => state.setToast);
  const [copiesCount, setCopiesCount] = useState(6);
  const [offsetAmount, setOffsetAmount] = useState(10);

  return (
    <>
      <PanelSection
        title="Layout"
        meta={
          node.type === "path"
            ? node.shape
              ? shapeDisplayName(node.shape.kind)
              : "Path"
            : node.type[0]!.toUpperCase() + node.type.slice(1)
        }
      >
        <AlignPanel nodeIds={[node.id]} />

        <div className={FIELD_GRID}>
          <NumberField
            label="X"
            unit="px"
            value={node.x}
            onCommit={(x) => patchSelection({ x })}
          />
          <NumberField
            label="Y"
            unit="px"
            value={node.y}
            onCommit={(y) => patchSelection({ y })}
          />
          <NumberField
            label="W"
            unit="px"
            value={node.width}
            onCommit={(width) => patchSelection({ width: Math.max(1, width) })}
          />
          <NumberField
            label="H"
            unit="px"
            value={node.height}
            onCommit={(height) =>
              patchSelection({ height: Math.max(1, height) })
            }
          />
          <NumberField
            label="∠"
            unit="°"
            value={node.rotation}
            onCommit={(rotation) => patchSelection({ rotation })}
          />
          {node.type === "rectangle" && (
            <NumberField
              label="◜"
              unit="px"
              value={node.cornerRadius}
              onCommit={(cornerRadius) =>
                patchSelection({ cornerRadius: Math.max(0, cornerRadius) })
              }
            />
          )}
          {node.type === "path" && node.shape?.kind === "polygon" && (
            <NumberField
              label="Sides"
              value={node.shape.sides ?? DEFAULT_POLYGON_SIDES}
              onCommit={(sides) => {
                const patch = shapeParamsPatch(node, { ...node.shape!, sides });
                if (patch) {
                  patchSelection(patch);
                }
              }}
            />
          )}
          {node.type === "path" && node.shape?.kind === "star" && (
            <>
              <NumberField
                label="Points"
                value={node.shape.sides ?? DEFAULT_STAR_POINTS}
                onCommit={(sides) => {
                  const patch = shapeParamsPatch(node, { ...node.shape!, sides });
                  if (patch) {
                    patchSelection(patch);
                  }
                }}
              />
              <NumberField
                label="Inner"
                unit="%"
                step={5}
                value={Math.round(
                  (node.shape.innerRatio ?? DEFAULT_STAR_INNER_RATIO) * 100,
                )}
                onCommit={(percent) => {
                  const patch = shapeParamsPatch(node, {
                    ...node.shape!,
                    innerRatio: percent / 100,
                  });
                  if (patch) {
                    patchSelection(patch);
                  }
                }}
              />
            </>
          )}
        </div>
      </PanelSection>

      <PanelSection
        title="Fill"
        meta={
          node.fill.type === "solid"
            ? node.fill.color.toUpperCase()
            : node.fill.type === "linear-gradient"
              ? "Linear gradient"
              : "Radial gradient"
        }
      >
        <FillEditor
          node={node}
          patchSelection={patchSelection}
          previewSelection={previewSelection}
          cancelPreview={cancelPreview}
        />
        <div className="mt-14 border-t border-panel-hairline pt-12">
          <div className={`${STROKE_HEAD} mb-8`}>
            <span>Palette</span>
            <span className="font-normal normal-case tracking-normal">
              Click to apply
            </span>
          </div>
          <div className={FIELD_ROW}>
            {document.palettes[0]?.colors.map((color) => (
              <button
                key={color}
                type="button"
                className={SWATCH}
                style={{ background: color }}
                aria-label={`Use ${color}`}
                onClick={() =>
                  patchSelection({ fill: { type: "solid", color } })
                }
              />
            ))}
          </div>
        </div>
      </PanelSection>
      <StrokeEditor
        node={node}
        patchSelection={patchSelection}
        previewSelection={previewSelection}
        cancelPreview={cancelPreview}
      />

      <PanelSection
        title="Appearance"
        meta={
          node.blendMode
            ? node.blendMode[0]!.toUpperCase() + node.blendMode.slice(1)
            : "Normal"
        }
      >
        {node.type === "path" && (
          <>
            <div className={STROKE_HEAD}>
              <span>Fill rule</span>
            </div>
            <div className={`${FIELD_ROW} mb-12`}>
              <select
                className={`${SELECT} min-w-0 flex-1`}
                value={node.fillRule}
                aria-label="Path fill rule"
                onChange={(event) =>
                  patchSelection({
                    fillRule: event.target.value as typeof node.fillRule,
                  })
                }
              >
                <option value="nonzero">Non-zero winding</option>
                <option value="evenodd">Even-odd holes</option>
              </select>
            </div>
          </>
        )}

        <div className={STROKE_HEAD}>
          <span>Blend mode</span>
        </div>
        <div className={FIELD_ROW}>
          <select
            className={`${SELECT} min-w-0 flex-1`}
            value={node.blendMode ?? "normal"}
            aria-label="Blend mode"
            onChange={(event) =>
              patchSelection({
                blendMode:
                  event.target.value === "normal"
                    ? undefined
                    : (event.target.value as LogoNode["blendMode"]),
              })
            }
          >
            <option value="normal">Normal</option>
            <option value="multiply">Multiply</option>
            <option value="screen">Screen</option>
            <option value="overlay">Overlay</option>
            <option value="darken">Darken</option>
            <option value="lighten">Lighten</option>
          </select>
        </div>
      </PanelSection>

      <PanelSection title="Create" defaultOpen={false}>
        <div className="rotate-copies mb-10 flex items-center gap-6">
          <NumberField
            label="×"
            ariaLabel="Rotated copy count"
            value={copiesCount}
            onCommit={(value) =>
              setCopiesCount(Math.max(2, Math.min(64, Math.round(value))))
            }
          />
          <button
            type="button"
            className={STROKE_TOGGLE}
            title="Repeat rotated copies around the artboard centre"
            onClick={() => {
              const ids = rotateCopies(node.id, copiesCount);
              if (ids.length > 0) {
                setSelection([node.id, ...ids]);
              }
            }}
          >
            <RotateCw size={12} /> Rotate copies
          </button>
        </div>

        {(node.type === "path" ||
          node.type === "rectangle" ||
          node.type === "ellipse") && (
          <div className="offset-path flex items-center gap-6">
            <NumberField
              label="±"
              ariaLabel="Path offset amount"
              unit="px"
              value={offsetAmount}
              onCommit={(value) => setOffsetAmount(Math.round(value * 10) / 10)}
            />
            <button
              type="button"
              className={STROKE_TOGGLE}
              title="New path offset outward (+) or inward (−) from this one"
              aria-label="Offset path"
              onClick={() => {
                void offsetPathOp(node.id, offsetAmount)
                  .then((newId) => {
                    if (newId) {
                      setSelection([newId]);
                    }
                  })
                  .catch((error: unknown) => {
                    console.warn("Offset path failed", error);
                    setToast(
                      "Offset path failed. The original shape was preserved.",
                    );
                  });
              }}
            >
              <Spline size={12} /> Offset path
            </button>
          </div>
        )}
      </PanelSection>

      {node.type === "text" && (
        <PanelSection title="Typography" meta={node.fontFamily.split(",")[0]?.trim()}>
        <div className="grid gap-10">
          <label className="grid gap-4 text-[11px] text-ink-dim">
            <span>Text</span>
            <TextContentField
              key={node.id}
              value={node.content}
              onPreview={(content) => previewSelection({ content })}
              onCommit={(content) => patchSelection({ content })}
              onCancel={cancelPreview}
            />
          </label>

          <div className={FIELD_ROW}>
            <FontPicker
              value={node.fontFamily}
              onApply={(family) => {
                const weight = nearestWeight(family, node.fontWeight);
                const style = nearestStyle(
                  family,
                  node.fontStyle ?? "normal",
                );
                void fontStore.ensure(family.name, weight, style);
                patchSelection({
                  fontFamily: family.name,
                  fontWeight: weight,
                  fontStyle: style === "italic" ? "italic" : undefined,
                });
              }}
            />
            <select
              className={`${SELECT} w-88`}
              value={node.fontWeight}
              onChange={(event) => {
                const weight = Number(event.target.value);
                void fontStore.ensure(
                  node.fontFamily,
                  weight,
                  node.fontStyle ?? "normal",
                );
                patchSelection({ fontWeight: weight });
              }}
              aria-label="Font weight"
            >
              {(catalogEntry(node.fontFamily)?.weights ?? [400, 700]).map(
                (weight) => (
                  <option key={weight} value={weight}>
                    {WEIGHT_LABELS[weight] ?? weight}
                  </option>
                ),
              )}
            </select>
            <button
              type="button"
              className={`h-28 w-28 flex-none rounded-field border text-[13px] italic transition-[border-color,color,background-color] duration-140 ease-studio ${
                node.fontStyle === "italic"
                  ? "active border-accent bg-accent/10 text-accent"
                  : "border-field-border bg-field text-ink-dim hover:enabled:border-accent hover:enabled:text-accent"
              } disabled:cursor-not-allowed disabled:opacity-40`}
              disabled={!catalogEntry(node.fontFamily)?.styles.includes("italic")}
              title={
                catalogEntry(node.fontFamily)?.styles.includes("italic")
                  ? "Italic"
                  : "This family has no italic cut"
              }
              aria-label="Italic"
              aria-pressed={node.fontStyle === "italic"}
              onClick={() => {
                const italic = node.fontStyle !== "italic";
                if (italic) {
                  void fontStore.ensure(node.fontFamily, node.fontWeight, "italic");
                }
                patchSelection({ fontStyle: italic ? "italic" : undefined });
              }}
            >
              I
            </button>
          </div>

          <TypeCraftControls node={node} patchSelection={patchSelection} />

          <div className={FIELD_GRID}>
            <NumberField
              label="Size"
              unit="px"
              value={node.fontSize}
              onCommit={(fontSize) =>
                patchSelection({ fontSize: Math.max(1, fontSize) })
              }
            />
            <NumberField
              label="Track"
              value={node.letterSpacing}
              step={0.1}
              onCommit={(letterSpacing) => patchSelection({ letterSpacing })}
            />
            <NumberField
              label="Line"
              value={node.lineHeight}
              step={0.05}
              onCommit={(lineHeight) =>
                patchSelection({ lineHeight: Math.max(0.5, lineHeight) })
              }
            />
            <div
              className="flex h-28 gap-2 overflow-hidden rounded-field border border-field-border bg-field p-2"
              role="group"
              aria-label="Text align"
            >
              {(
                [
                  ["left", AlignLeft],
                  ["center", AlignCenter],
                  ["right", AlignRight],
                ] as const
              ).map(([align, Icon]) => (
                <button
                  key={align}
                  type="button"
                  className={`grid flex-1 place-items-center rounded-[4px] transition-[background-color,color] duration-120 ease-studio ${
                    node.align === align
                      ? "active bg-card text-accent shadow-tab"
                      : "text-ink-dim hover:text-ink"
                  }`}
                  onClick={() => patchSelection({ align })}
                  title={`Align ${align}`}
                  aria-label={`Align ${align}`}
                  aria-pressed={node.align === align}
                >
                  <Icon size={14} />
                </button>
              ))}
            </div>
          </div>

          {node.onPath && (
            <TextPathControls node={node} patchSelection={patchSelection} />
          )}

          <button
            type="button"
            className={OUTLINE_BUTTON}
            disabled={node.content.length === 0 || Boolean(node.onPath)}
            title={
              node.onPath ? "Detach from path first" : "Convert to outlines"
            }
            onClick={() => {
              void Fx.runPromise(convertTextToPath(node.id))
                .then((newId) => {
                  if (newId) {
                    setSelection([newId]);
                  }
                })
                .catch((error: unknown) => {
                  console.warn("Convert to outlines failed", error);
                  setToast(
                    error &&
                      typeof error === "object" &&
                      "reason" in error &&
                      typeof error.reason === "string"
                      ? error.reason
                      : "Could not convert this text. The original was preserved.",
                  );
                });
            }}
          >
            Convert to outlines
          </button>
        </div>
        </PanelSection>
      )}
    </>
  );
}

/**
 * OpenType feature toggles (what Skia Paragraph honours; ligatures at
 * minimum) and the manual-kerning summary row. Kerning itself is edited
 * on canvas: text edit mode, caret between two glyphs, ⌥←/⌥→ (⇧ for
 * coarse steps) — this row shows the count and clears the map.
 */
function TypeCraftControls({
  node,
  patchSelection,
}: {
  node: TextNode;
  patchSelection: (patch: NodePatch) => void;
}) {
  const features = node.otFeatures ?? {};
  const kernCount = kernedPairCount(node);

  const setFeatures = (patch: Record<string, boolean | undefined>) => {
    const next: Record<string, boolean> = { ...features };
    for (const [tag, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete next[tag];
      } else {
        next[tag] = value;
      }
    }
    patchSelection({
      otFeatures: Object.keys(next).length > 0 ? next : undefined,
    });
  };

  const featureToggle = (
    label: string,
    tags: string[],
    defaultOn: boolean,
  ) => {
    const on = tags.every((tag) => features[tag] ?? defaultOn);
    return (
      <label
        key={label}
        className="inline-flex cursor-pointer items-center gap-5 text-[11.5px] text-ink-dim"
      >
        <input
          type="checkbox"
          checked={on}
          aria-label={label}
          onChange={(event) => {
            const value = event.target.checked;
            setFeatures(
              Object.fromEntries(
                tags.map((tag) => [tag, value === defaultOn ? undefined : value]),
              ),
            );
          }}
        />
        {label}
      </label>
    );
  };

  return (
    <div className="type-craft grid gap-6">
      <div className="flex flex-wrap items-center gap-10">
        {featureToggle("Ligatures", ["liga", "clig"], true)}
        {featureToggle("Discretionary", ["dlig"], false)}
        {featureToggle("Small caps", ["smcp"], false)}
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-4 text-[11px] text-ink-dim">
        <span
          className="min-w-0 flex-1 leading-[1.35]"
          data-testid="kerned-pairs"
        >
          {kernCount > 0
            ? `${kernCount} kerned pair${kernCount === 1 ? "" : "s"}`
            : "Kern: caret in text edit, ⌥← / ⌥→"}
        </span>
        {kernCount > 0 && (
          <button
            type="button"
            className={STROKE_TOGGLE}
            aria-label="Reset kerning"
            onClick={() => patchSelection({ kerning: undefined })}
          >
            Reset kerning
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Controls for a text node attached to a path: start offset along the
 * arc (slider + field), flip side, detach. Offset max derives from the
 * path's arc length.
 */
function TextPathControls({
  node,
  patchSelection,
}: {
  node: TextNode;
  patchSelection: (patch: NodePatch) => void;
}) {
  const document = useDocument();
  const attachment = node.onPath!;
  const length = Math.max(
    1,
    Math.round(pathNodeLength(document, attachment.pathId)),
  );

  return (
    <div className="text-path-block mt-10">
      <div className={STROKE_HEAD}>
        <span>On path</span>
        <button
          type="button"
          className={STROKE_TOGGLE}
          aria-label="Detach from path"
          onClick={() => detachTextFromPath(node.id)}
        >
          Detach
        </button>
      </div>
      <div className={FILL_ROW}>
        <input
          type="range"
          min="0"
          max={length}
          step="1"
          className="flex-1 accent-accent"
          value={Math.min(attachment.startOffset, length)}
          aria-label="Path offset"
          onChange={(event) =>
            patchSelection({
              onPath: { ...attachment, startOffset: Number(event.target.value) },
            })
          }
        />
        <NumberField
          label="Off"
          unit="px"
          value={attachment.startOffset}
          onCommit={(startOffset) =>
            patchSelection({
              onPath: { ...attachment, startOffset: Math.max(0, startOffset) },
            })
          }
        />
      </div>
      <button
        type="button"
        className={attachment.flip ? `${STROKE_TOGGLE_ACTIVE} active` : STROKE_TOGGLE}
        aria-label="Flip side"
        aria-pressed={attachment.flip}
        onClick={() =>
          patchSelection({ onPath: { ...attachment, flip: !attachment.flip } })
        }
      >
        <FlipVertical2 size={12} /> Flip side
      </button>
    </div>
  );
}

const EFFECT_LABELS: Record<Effect["type"], string> = {
  "drop-shadow": "Drop shadow",
  outline: "Outline",
  bevel: "Bevel",
  glow: "Glow",
};

function defaultEffect(type: Effect["type"]): Effect {
  switch (type) {
    case "drop-shadow":
      return {
        type,
        enabled: true,
        dx: 3,
        dy: 4,
        blur: 8,
        color: "#0f172a",
        opacity: 0.35,
      };
    case "outline":
      return { type, enabled: true, width: 3, color: "#7c5cff", opacity: 1 };
    case "bevel":
      return { type, enabled: true, size: 2, soften: 4, intensity: 0.55 };
    case "glow":
      return {
        type,
        enabled: true,
        blur: 12,
        color: "#f59e0b",
        opacity: 0.85,
      };
  }
}

/**
 * Layer-effect stack for the selected node (any type, groups included).
 * Every change replaces the whole `effects` array in one update-nodes
 * command, so add/remove/toggle/param edits are single undo entries.
 */
function EffectsSection({ node }: { node: LogoNode }) {
  const effects = node.effects ?? [];

  function setEffects(next: Effect[]) {
    documentStore.apply({
      type: "update-nodes",
      updates: [
        {
          nodeId: node.id,
          patch: { effects: next.length > 0 ? next : undefined },
        },
      ],
    });
  }

  function updateAt(index: number, patch: Partial<Effect>) {
    setEffects(
      effects.map((effect, i) =>
        i === index ? ({ ...effect, ...patch } as Effect) : effect,
      ),
    );
  }

  return (
    <PanelSection
      title="Effects"
      action={
        <select
          className="ui-select h-26 rounded-field border border-field-border bg-card px-7 text-[11px] text-ink-dim"
          value=""
          aria-label="Add effect"
          onChange={(event) => {
            const type = event.target.value as Effect["type"] | "";
            if (type) {
              setEffects([...effects, defaultEffect(type)]);
            }
          }}
        >
          <option value="">Add…</option>
          <option value="drop-shadow">Drop shadow</option>
          <option value="outline">Outline</option>
          <option value="bevel">Bevel</option>
          <option value="glow">Glow</option>
        </select>
      }
    >

      {effects.length === 0 ? (
        <p className={MUTED}>
          Add depth or emphasis with a shadow, outline, bevel, or glow.
        </p>
      ) : (
        <div className="flex flex-col gap-8">
          {effects.map((effect, index) => (
            <div
              key={`${effect.type}-${index}`}
              className={`effect-row rounded-field border border-field-border px-8 pb-5 pt-7${
                effect.enabled ? "" : " is-off"
              }`}
              role="group"
              aria-label={`${EFFECT_LABELS[effect.type]} effect`}
            >
              <div className="mb-6 flex items-center justify-between">
                <label className="inline-flex cursor-pointer items-center gap-6 text-[12px] font-semibold text-ink">
                  <input
                    type="checkbox"
                    checked={effect.enabled}
                    aria-label={`Toggle ${EFFECT_LABELS[effect.type]}`}
                    onChange={(event) =>
                      updateAt(index, { enabled: event.target.checked })
                    }
                  />
                  <span>{EFFECT_LABELS[effect.type]}</span>
                </label>
                <button
                  type="button"
                  className={STROKE_TOGGLE}
                  aria-label={`Remove ${EFFECT_LABELS[effect.type]}`}
                  onClick={() =>
                    setEffects(effects.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </button>
              </div>

              {effect.type === "drop-shadow" && (
                <div
                  className={`${FILL_ROW} effect-params flex-wrap${
                    effect.enabled ? "" : " opacity-45"
                  }`}
                >
                  <NumberField
                    label="X"
                    value={effect.dx}
                    onCommit={(dx) => updateAt(index, { dx })}
                  />
                  <NumberField
                    label="Y"
                    value={effect.dy}
                    onCommit={(dy) => updateAt(index, { dy })}
                  />
                  <NumberField
                    label="Blur"
                    value={effect.blur}
                    onCommit={(blur) =>
                      updateAt(index, { blur: Math.max(0, blur) })
                    }
                  />
                  <input
                    type="color"
                    className={FILL_SWATCH}
                    value={effect.color}
                    aria-label="Shadow color"
                    onChange={(event) =>
                      updateAt(index, { color: event.target.value })
                    }
                  />
                  <NumberField
                    label="Op"
                    unit="%"
                    step={5}
                    value={Math.round(effect.opacity * 100)}
                    onCommit={(percent) =>
                      updateAt(index, {
                        opacity: Math.min(1, Math.max(0, percent / 100)),
                      })
                    }
                  />
                </div>
              )}

              {effect.type === "outline" && (
                <div
                  className={`${FILL_ROW} effect-params flex-wrap${
                    effect.enabled ? "" : " opacity-45"
                  }`}
                >
                  <NumberField
                    label="W"
                    unit="px"
                    step={0.5}
                    value={effect.width}
                    onCommit={(width) =>
                      updateAt(index, { width: Math.max(0, width) })
                    }
                  />
                  <input
                    type="color"
                    className={FILL_SWATCH}
                    value={effect.color}
                    aria-label="Outline color"
                    onChange={(event) =>
                      updateAt(index, { color: event.target.value })
                    }
                  />
                  <NumberField
                    label="Op"
                    unit="%"
                    step={5}
                    value={Math.round(effect.opacity * 100)}
                    onCommit={(percent) =>
                      updateAt(index, {
                        opacity: Math.min(1, Math.max(0, percent / 100)),
                      })
                    }
                  />
                </div>
              )}

              {effect.type === "bevel" && (
                <div
                  className={`${FILL_ROW} effect-params flex-wrap${
                    effect.enabled ? "" : " opacity-45"
                  }`}
                >
                  <NumberField
                    label="Size"
                    unit="px"
                    value={effect.size}
                    onCommit={(size) =>
                      updateAt(index, { size: Math.max(0, size) })
                    }
                  />
                  <NumberField
                    label="Soft"
                    unit="px"
                    value={effect.soften}
                    onCommit={(soften) =>
                      updateAt(index, { soften: Math.max(0, soften) })
                    }
                  />
                  <NumberField
                    label="Amt"
                    unit="%"
                    step={5}
                    value={Math.round(effect.intensity * 100)}
                    onCommit={(percent) =>
                      updateAt(index, {
                        intensity: Math.min(1, Math.max(0, percent / 100)),
                      })
                    }
                  />
                </div>
              )}

              {effect.type === "glow" && (
                <div
                  className={`${FILL_ROW} effect-params flex-wrap${
                    effect.enabled ? "" : " opacity-45"
                  }`}
                >
                  <NumberField
                    label="Blur"
                    value={effect.blur}
                    onCommit={(blur) =>
                      updateAt(index, { blur: Math.max(0, blur) })
                    }
                  />
                  <input
                    type="color"
                    className={FILL_SWATCH}
                    value={effect.color}
                    aria-label="Glow color"
                    onChange={(event) =>
                      updateAt(index, { color: event.target.value })
                    }
                  />
                  <NumberField
                    label="Op"
                    unit="%"
                    step={5}
                    value={Math.round(effect.opacity * 100)}
                    onCommit={(percent) =>
                      updateAt(index, {
                        opacity: Math.min(1, Math.max(0, percent / 100)),
                      })
                    }
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </PanelSection>
  );
}

function ClippingPathOwnershipSection({ ownerId }: { ownerId: string }) {
  const document = useDocument();
  const setSelection = useEditorStore((state) => state.setSelection);
  const owner = document.nodes[ownerId];
  if (owner?.type !== "group" || !owner.clippingMaskId) {
    return null;
  }

  return (
    <section className={SECTION}>
      <header className={SECTION_HEAD}>
        <h2 className={`${SECTION_H2} flex items-center gap-5`}>
          <Crop size={12} aria-hidden="true" /> Clipping path
        </h2>
        <span className={SECTION_META}>Owned by {owner.name}</span>
      </header>
      <p className={`${MUTED} mb-10`}>
        This shape clips its sibling content. Fill, stroke, opacity and effects
        are stored but do not paint until the mask is released.
      </p>
      <button
        type="button"
        className={OUTLINE_BUTTON}
        onClick={() => setSelection([owner.id])}
      >
        Select clipping group
      </button>
    </section>
  );
}

function GroupSection({ group }: { group: GroupNode }) {
  const document = useDocument();
  const setSelection = useEditorStore((state) => state.setSelection);
  // Remount key so the rotate-by field snaps back to 0 after committing.
  const [rotateNonce, setRotateNonce] = useState(0);
  const bounds =
    unitBounds(document, group.id) ??
    (group.clippingMaskId
      ? unitBounds(document, group.clippingMaskId)
      : null);
  const leafCount = collectLeafNodeIds(document, [group.id]).length;
  const isClippingGroup = group.clippingMaskId !== undefined;
  const contentCount = Math.max(0, leafCount - (isClippingGroup ? 1 : 0));

  if (!bounds) {
    return null;
  }

  return (
    <section className={SECTION}>
      <header className={SECTION_HEAD}>
        <h2 className={SECTION_H2}>
          {isClippingGroup ? "Clipping group" : "Group"}
        </h2>
        <span className={SECTION_META}>
          {isClippingGroup
            ? `${contentCount} content object${contentCount === 1 ? "" : "s"}`
            : `${leafCount} object${leafCount === 1 ? "" : "s"}`}
        </span>
      </header>

      {isClippingGroup && (
        <p className={`${MUTED} mb-10`}>
          The clipping path controls the visible area. Its original paint is
          preserved and returns when you release the mask.
        </p>
      )}

      <AlignPanel nodeIds={[group.id]} />

      <div className={FIELD_GRID}>
        <NumberField
          label="X"
          unit="px"
          value={bounds.x}
          onCommit={(x) => setUnitBounds(group.id, { x })}
        />
        <NumberField
          label="Y"
          unit="px"
          value={bounds.y}
          onCommit={(y) => setUnitBounds(group.id, { y })}
        />
        <NumberField
          label="W"
          unit="px"
          value={bounds.width}
          onCommit={(width) =>
            setUnitBounds(group.id, { width: Math.max(1, width) })
          }
        />
        <NumberField
          label="H"
          unit="px"
          value={bounds.height}
          onCommit={(height) =>
            setUnitBounds(group.id, { height: Math.max(1, height) })
          }
        />
        <NumberField
          key={rotateNonce}
          label="∠+"
          unit="°"
          value={0}
          onCommit={(degrees) => {
            rotateUnitBy(group.id, degrees);
            setRotateNonce((nonce) => nonce + 1);
          }}
        />
      </div>

      <div className={FILL_ROW}>
        <div className={OPACITY_FIELD}>
          <OpacityField
            value={group.opacity}
            onPreview={(opacity) =>
              documentStore.preview([
                { nodeId: group.id, patch: { opacity } },
              ])
            }
            onCommit={(opacity) =>
              documentStore.apply({
                type: "update-nodes",
                updates: [
                  {
                    nodeId: group.id,
                    patch: { opacity },
                  },
                ],
              })
            }
            onCancel={() => documentStore.cancelPreview()}
            ariaLabel="Group opacity"
          />
        </div>
      </div>

      {/* Blend mode lives on the group itself: the renderer composites
          the whole subtree as one layer, not per child. */}
      <div className={STROKE_HEAD}>
        <span>Blend</span>
      </div>
      <div className={`${FIELD_ROW} mb-10`}>
        <select
          className={`${SELECT} min-w-0 flex-1`}
          value={group.blendMode ?? "normal"}
          aria-label="Blend mode"
          onChange={(event) =>
            documentStore.apply({
              type: "update-nodes",
              updates: [
                {
                  nodeId: group.id,
                  patch: {
                    blendMode:
                      event.target.value === "normal"
                        ? undefined
                        : (event.target.value as LogoNode["blendMode"]),
                  },
                },
              ],
            })
          }
        >
          <option value="normal">Normal</option>
          <option value="multiply">Multiply</option>
          <option value="screen">Screen</option>
          <option value="overlay">Overlay</option>
          <option value="darken">Darken</option>
          <option value="lighten">Lighten</option>
        </select>
      </div>

      <button
        type="button"
        className={OUTLINE_BUTTON}
        onClick={() => {
          const freed = isClippingGroup
            ? releaseClippingMask([group.id])
            : ungroupSelection([group.id]);
          if (freed && freed.length > 0) {
            setSelection(freed);
          }
        }}
      >
        {isClippingGroup ? "Release clipping mask (⌥⌘7)" : "Ungroup (⇧⌘G)"}
      </button>
    </section>
  );
}

function SwatchesSection() {
  const document = useDocument();
  const palette = document.palettes[0];
  // Print readout for the swatch under the pointer (display only).
  const [inspected, setInspected] = useState<string | null>(null);
  if (!palette) {
    return null;
  }

  const info = inspected ? colorInfo(inspected) : null;

  return (
    <PanelSection
      title="Brand palette"
      meta={`${palette.colors.length} colors`}
      defaultOpen={false}
    >
      <div className={FIELD_ROW}>
        {palette.colors.map((color, index) => (
          <input
            key={`${index}-${color}`}
            type="color"
            className={`swatch-editable ${SWATCH}`}
            defaultValue={color}
            aria-label={`Edit brand color ${index + 1}`}
            title="Edit — recolors every use"
            onPointerEnter={() => setInspected(color)}
            onFocus={() => setInspected(color)}
            onBlur={(event) => {
              if (event.target.value !== color) {
                editSwatch(palette.id, index, event.target.value);
              }
            }}
          />
        ))}
      </div>
      {info && inspected ? (
        <p
          className={`${MUTED} mt-8 tabular-nums`}
          data-testid="swatch-print-info"
        >
          {inspected.toUpperCase()} · {info.cmykLabel}
          {info.spot ? ` · ≈ ${info.spot.name}` : ""}
          {info.gamutHint ? " · ⚠ vivid for print" : ""}
        </p>
      ) : (
        <p className={`${MUTED} mt-8`}>
          Editing a brand color updates every use. Focus or hover for print
          values.
        </p>
      )}
    </PanelSection>
  );
}

type LayerRow = {
  node: LogoNode;
  depth: number;
  /** Artboard id (top level) or parent group id. */
  containerId: string;
  /** z-index within the container's ordering (back-to-front). */
  zIndex: number;
};

/** Flattened tree rows, topmost-first, honoring expanded groups. */
function buildLayerRows(
  document: LogoDocument,
  containerId: string,
  childIds: readonly string[],
  depth: number,
  expanded: ReadonlySet<string>,
): LayerRow[] {
  const rows: LayerRow[] = [];
  for (let zIndex = childIds.length - 1; zIndex >= 0; zIndex -= 1) {
    const node = document.nodes[childIds[zIndex]!];
    if (!node) {
      continue;
    }
    rows.push({ node, depth, containerId, zIndex });
    if (node.type === "group" && expanded.has(node.id)) {
      rows.push(
        ...buildLayerRows(document, node.id, node.children, depth + 1, expanded),
      );
    }
  }
  return rows;
}

/** Live thumbnail; memo + useMemo cache it until the document changes. */
const LayerThumb = memo(function LayerThumb({
  document,
  node,
}: {
  document: LogoDocument;
  node: LogoNode;
}) {
  const svg = useMemo(
    () => nodeToPreviewSvg(document, node.id),
    [document, node.id],
  );

  if (!svg) {
    const Icon = NODE_ICONS[node.type];
    return (
      <i className="layer-thumb layer-thumb-empty" aria-hidden="true">
        <Icon size={12} strokeWidth={1.75} />
      </i>
    );
  }
  // Same generator as the SVG export, so the preview is trustworthy.
  return (
    <i
      className="layer-thumb"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});

function LayerRenameField({
  node,
  onDone,
}: {
  node: LogoNode;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(node.name);
  const cancelledRef = useRef(false);

  function commit() {
    if (cancelledRef.current) {
      onDone();
      return;
    }
    const name = draft.trim();
    if (name && name !== node.name) {
      documentStore.apply({
        type: "update-nodes",
        updates: [{ nodeId: node.id, patch: { name } }],
      });
    }
    onDone();
  }

  return (
    <input
      className="layer-rename"
      value={draft}
      autoFocus
      aria-label="Layer name"
      onFocus={(event) => event.target.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          (event.target as HTMLInputElement).blur();
        } else if (event.key === "Escape") {
          cancelledRef.current = true;
          onDone();
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
}

const BLEND_BADGES: Record<string, string> = {
  multiply: "Mul",
  screen: "Scr",
  overlay: "Ovl",
  darken: "Drk",
  lighten: "Lgt",
};

type DropZone = "before" | "after" | "inside";
type DropSpec = { rowIndex: number; zone: DropZone };

function LayersSection() {
  const document = useDocument();
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const setSelection = useEditorStore((state) => state.setSelection);
  const setActiveGroupId = useEditorStore((state) => state.setActiveGroupId);
  // Ref, not state: drop can fire before a state commit lands.
  const dragRef = useRef<LayerRow | null>(null);
  const [drop, setDrop] = useState<DropSpec | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const artboard = document.artboards.find(
    (item) => item.id === document.activeArtboardId,
  );
  const rows = artboard
    ? buildLayerRows(document, artboard.id, artboard.nodeIds, 0, expanded)
    : [];
  const hasGroups = rows.some((row) => row.node.type === "group");
  const objectCount = artboard
    ? collectLeafNodeIds(document, artboard.nodeIds).length
    : 0;

  function toggle(nodeId: string, patch: NodePatch) {
    documentStore.apply({ type: "update-nodes", updates: [{ nodeId, patch }] });
  }

  function toggleExpanded(groupId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  function moveLayerByKeyboard(row: LayerRow, direction: -1 | 1) {
    const siblings = getContainerChildIds(document, row.containerId);
    const toIndex = Math.min(
      siblings.length - 1,
      Math.max(0, row.zIndex + direction),
    );
    if (toIndex === row.zIndex) {
      setAnnouncement(
        `${row.node.name} is already at the ${direction > 0 ? "top" : "bottom"}.`,
      );
      return;
    }
    documentStore.apply({
      type: "reorder-node",
      containerId: row.containerId,
      nodeId: row.node.id,
      toIndex,
    });
    setAnnouncement(
      `${row.node.name} moved ${direction > 0 ? "up" : "down"} to position ${
        siblings.length - toIndex
      } of ${siblings.length}.`,
    );
  }

  function indentLayerByKeyboard(row: LayerRow, rowIndex: number) {
    let previousSibling: LayerRow | undefined;
    for (let index = rowIndex - 1; index >= 0; index -= 1) {
      const candidate = rows[index]!;
      if (candidate.depth < row.depth) {
        break;
      }
      if (candidate.depth === row.depth) {
        previousSibling = candidate;
        break;
      }
    }
    if (
      previousSibling?.containerId !== row.containerId ||
      previousSibling.node.type !== "group"
    ) {
      setAnnouncement(`${row.node.name} has no group directly above it.`);
      return;
    }
    const targetGroup = previousSibling.node;
    moveUnitToContainer(
      row.node.id,
      targetGroup.id,
      getContainerChildIds(document, targetGroup.id).length,
    );
    setExpanded((current) => new Set(current).add(targetGroup.id));
    setAnnouncement(`${row.node.name} moved into ${targetGroup.name}.`);
  }

  function outdentLayerByKeyboard(row: LayerRow) {
    const parentGroup = document.nodes[row.containerId];
    if (parentGroup?.type !== "group") {
      setAnnouncement(`${row.node.name} is already at the artboard level.`);
      return;
    }
    const targetContainerId = findContainerId(document, parentGroup.id);
    if (!targetContainerId) {
      return;
    }
    const parentIndex = getContainerChildIds(
      document,
      targetContainerId,
    ).indexOf(parentGroup.id);
    moveUnitToContainer(
      row.node.id,
      targetContainerId,
      Math.max(0, parentIndex),
    );
    setAnnouncement(`${row.node.name} moved out of ${parentGroup.name}.`);
  }

  /**
   * Drop zone from the pointer position within the row: edges insert
   * between rows, a group's middle nests into it. Null when the event has
   * no usable coordinates (synthetic DnD, e.g. regression scripts) — those
   * keep the legacy whole-row semantics.
   */
  function zoneAt(
    event: React.DragEvent<HTMLDivElement>,
    row: LayerRow,
  ): DropZone | null {
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientY < rect.top || event.clientY > rect.bottom) {
      return null;
    }
    const ratio = (event.clientY - rect.top) / rect.height;
    if (row.node.type === "group") {
      return ratio < 0.3 ? "before" : ratio > 0.7 ? "after" : "inside";
    }
    return ratio < 0.5 ? "before" : "after";
  }

  function handleDrop(
    event: React.DragEvent<HTMLDivElement>,
    target: LayerRow,
  ) {
    const zone = zoneAt(event, target);
    const dragged = dragRef.current;
    dragRef.current = null;
    setDrop(null);
    if (!dragged || dragged.node.id === target.node.id) {
      return;
    }

    // Onto a group row's body nests into it, topmost in its stack;
    // onto the group that already holds it, reorders to the top instead.
    if (target.node.type === "group" && (zone === "inside" || zone === null)) {
      const childIds = getContainerChildIds(document, target.node.id);
      if (target.node.id === dragged.containerId) {
        documentStore.apply({
          type: "reorder-node",
          containerId: dragged.containerId,
          nodeId: dragged.node.id,
          toIndex: childIds.length - 1,
        });
      } else {
        moveUnitToContainer(dragged.node.id, target.node.id, childIds.length);
      }
      return;
    }

    if (zone === null) {
      // Legacy whole-row drop: another container moves it there (into or
      // out of groups); within one container it stays a reorder.
      if (dragged.containerId !== target.containerId) {
        moveUnitToContainer(dragged.node.id, target.containerId, target.zIndex);
        return;
      }
      documentStore.apply({
        type: "reorder-node",
        containerId: dragged.containerId,
        nodeId: dragged.node.id,
        toIndex: target.zIndex,
      });
      return;
    }

    // Between-row drop. Rows render topmost-first, so the slot visually
    // above a row is one z-index higher within its container.
    const insertIndex = zone === "before" ? target.zIndex + 1 : target.zIndex;
    if (dragged.containerId === target.containerId) {
      const list = getContainerChildIds(document, dragged.containerId);
      const fromIndex = list.indexOf(dragged.node.id);
      if (fromIndex === -1) {
        return;
      }
      // reorder-node splices after removal: slots above shift down one.
      const toIndex = insertIndex > fromIndex ? insertIndex - 1 : insertIndex;
      if (toIndex === fromIndex) {
        return;
      }
      documentStore.apply({
        type: "reorder-node",
        containerId: dragged.containerId,
        nodeId: dragged.node.id,
        toIndex,
      });
    } else {
      moveUnitToContainer(dragged.node.id, target.containerId, insertIndex);
    }
  }

  return (
    <section className={SECTION}>
      <header className={SECTION_HEAD}>
        <h2 className={SECTION_H2}>Layers</h2>
        <span className={SECTION_META}>
          {objectCount} object{objectCount === 1 ? "" : "s"}
        </span>
      </header>
      <p id="layer-keyboard-help" className="sr-only">
        Press F2 to rename. Hold Alt and press Arrow Up or Arrow Down to
        reorder within the current group. Alt Arrow Right moves a layer into
        the group directly above it; Alt Arrow Left moves it out of its current
        group. On a group, press Alt Enter to open it.
      </p>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <div className="layer-rows">
        {rows.map((row, rowIndex) => {
          const { node } = row;
          const selected = selectedNodeIds.includes(node.id);
          const isGroup = node.type === "group";
          const isExpanded = isGroup && expanded.has(node.id);
          const renaming = renamingId === node.id;
          const clippingOwnerId = getClippingMaskOwnerId(document, node.id);
          const isClippingPath = clippingOwnerId !== null;
          const isClippingGroup = isGroup && node.clippingMaskId !== undefined;
          const badge = [
            isClippingPath ? "Mask" : isClippingGroup ? "Clip" : null,
            node.blendMode ? BLEND_BADGES[node.blendMode] : null,
            node.opacity !== 1 ? `${Math.round(node.opacity * 100)}%` : null,
          ]
            .filter(Boolean)
            .join(" ");
          const dropClass =
            drop?.rowIndex === rowIndex ? ` drop-${drop.zone}` : "";
          return (
            <div
              key={node.id}
              className={`layer-row${selected ? " active" : ""}${
                node.visible ? "" : " is-hidden"
              }${dropClass}`}
              draggable={!renaming && !isClippingPath}
              onDragStart={(event) => {
                if (isClippingPath) {
                  event.preventDefault();
                  setAnnouncement(
                    "Release the clipping mask before moving its clipping path.",
                  );
                  return;
                }
                dragRef.current = row;
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                event.preventDefault();
                const zone = zoneAt(event, row);
                const spec: DropSpec | null =
                  zone === null
                    ? isGroup
                      ? { rowIndex, zone: "inside" }
                      : null
                    : { rowIndex, zone };
                setDrop((current) =>
                  current?.rowIndex === spec?.rowIndex &&
                  current?.zone === spec?.zone
                    ? current
                    : spec,
                );
              }}
              onDragLeave={() =>
                setDrop((current) =>
                  current?.rowIndex === rowIndex ? null : current,
                )
              }
              onDrop={(event) => {
                event.preventDefault();
                handleDrop(event, row);
              }}
              onDragEnd={() => {
                dragRef.current = null;
                setDrop(null);
              }}
            >
              {Array.from({ length: row.depth }, (_, i) => (
                <i key={i} className="layer-indent" />
              ))}
              {isGroup ? (
                <button
                  type="button"
                  className="layer-caret"
                  onClick={() => toggleExpanded(node.id)}
                  title={isExpanded ? "Collapse" : "Expand"}
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.name}`}
                  aria-expanded={isExpanded}
                >
                  {isExpanded ? (
                    <ChevronDown size={12} />
                  ) : (
                    <ChevronRight size={12} />
                  )}
                </button>
              ) : (
                hasGroups && <i className="layer-caret-space" />
              )}
              {renaming ? (
                <div className="layer-main">
                  <LayerThumb document={document} node={node} />
                  <LayerRenameField
                    node={node}
                    onDone={() => setRenamingId(null)}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className="layer-main"
                  aria-label={
                    isClippingPath
                      ? `${node.name}, clipping path owned by ${
                          document.nodes[clippingOwnerId]?.name ??
                          "clipping group"
                        }`
                      : isClippingGroup
                        ? `${node.name}, clipping group, ${node.children.length - 1} content layers and one clipping path`
                        : isGroup
                      ? `${node.name}, group, ${node.children.length} layers`
                      : node.name
                  }
                  aria-pressed={selected}
                  aria-describedby="layer-keyboard-help"
                  aria-keyshortcuts={
                    isGroup
                      ? "F2 Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight Alt+Enter"
                      : "F2 Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
                  }
                  onClick={(event) =>
                    setSelection(
                      event.shiftKey && !selected
                        ? [...selectedNodeIds, node.id]
                        : [node.id],
                    )
                  }
                  onDoubleClick={() => {
                    if (isGroup) {
                      setActiveGroupId(node.id);
                      toggleExpanded(node.id);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "F2") {
                      event.preventDefault();
                      setRenamingId(node.id);
                    } else if (event.altKey && event.key === "ArrowUp") {
                      event.preventDefault();
                      moveLayerByKeyboard(row, 1);
                    } else if (event.altKey && event.key === "ArrowDown") {
                      event.preventDefault();
                      moveLayerByKeyboard(row, -1);
                    } else if (event.altKey && event.key === "ArrowRight") {
                      event.preventDefault();
                      if (isClippingPath) {
                        setAnnouncement(
                          "Release the clipping mask before moving its clipping path.",
                        );
                      } else {
                        indentLayerByKeyboard(row, rowIndex);
                      }
                    } else if (event.altKey && event.key === "ArrowLeft") {
                      event.preventDefault();
                      if (isClippingPath) {
                        setAnnouncement(
                          "Release the clipping mask before moving its clipping path.",
                        );
                      } else {
                        outdentLayerByKeyboard(row);
                      }
                    } else if (event.altKey && event.key === "Enter" && isGroup) {
                      event.preventDefault();
                      setActiveGroupId(node.id);
                      if (!isExpanded) {
                        toggleExpanded(node.id);
                      }
                    }
                  }}
                >
                  <LayerThumb document={document} node={node} />
                  <span
                    className="layer-name"
                    title="Double-click to rename"
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      setRenamingId(node.id);
                    }}
                  >
                    {node.name}
                  </span>
                  {isGroup && (
                    <small className="layer-count" aria-hidden="true">
                      {node.children.length}
                    </small>
                  )}
                  {badge && <small className="layer-badge">{badge}</small>}
                </button>
              )}
              <button
                type="button"
                className="layer-toggle"
                onClick={() =>
                  !isClippingPath && toggle(node.id, { visible: !node.visible })
                }
                title={
                  isClippingPath
                    ? "Visibility is owned by the clipping group"
                    : node.visible
                      ? "Hide"
                      : "Show"
                }
                aria-label={`${node.name} visible`}
                aria-pressed={node.visible}
                disabled={isClippingPath}
              >
                {node.visible ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <button
                type="button"
                className={`layer-toggle ${node.locked ? "is-on" : ""}`}
                onClick={() => toggle(node.id, { locked: !node.locked })}
                title={node.locked ? "Unlock" : "Lock"}
                aria-label={`${node.name} locked`}
                aria-pressed={node.locked}
              >
                {node.locked ? <Lock size={13} /> : <Unlock size={13} />}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MultiDesignSection({
  nodes,
  patchSelection,
  previewSelection,
  cancelPreview,
}: {
  nodes: LogoNode[];
  patchSelection: (patch: NodePatch) => void;
  previewSelection: (patch: NodePatch) => void;
  cancelPreview: () => void;
}) {
  const document = useDocument();
  const setSelection = useEditorStore((state) => state.setSelection);
  // Show the first drawable leaf's paint (a group's fill is a placeholder).
  const firstLeafId = collectLeafNodeIds(
    document,
    nodes.map((node) => node.id),
  )[0];
  const first = (firstLeafId && document.nodes[firstLeafId]) || nodes[0]!;
  const textPathPair = isTextPathPair(
    document,
    nodes.map((node) => node.id),
  );

  return (
    <>
      <PanelSection title="Layout" meta={`${nodes.length} selected`}>
        <AlignPanel nodeIds={nodes.map((node) => node.id)} />
        {textPathPair && (
          <button
            type="button"
            className={OUTLINE_BUTTON}
            title="Lay the text out along the selected path"
            onClick={() => {
              attachTextToPath(textPathPair.text.id, textPathPair.path.id);
              setSelection([textPathPair.text.id]);
            }}
          >
            Put on path
          </button>
        )}
      </PanelSection>
      <PanelSection title="Fill" meta="Applies to selection">
        <PaintEditor
          paint={first.fill}
          label="Fill"
          onCommit={(fill) => patchSelection({ fill })}
          onPreview={(fill) => previewSelection({ fill })}
          onCancelPreview={cancelPreview}
        />
        <div className="mt-12 grid grid-cols-[54px_minmax(0,1fr)] items-center gap-8">
          <span className="text-[11px] font-[600] text-ink-dim">Opacity</span>
          <div className={OPACITY_FIELD}>
            <OpacityField
              value={first.opacity}
              onPreview={(opacity) => previewSelection({ opacity })}
              onCommit={(opacity) => patchSelection({ opacity })}
              onCancel={cancelPreview}
            />
          </div>
        </div>
        <div className="mt-14 border-t border-panel-hairline pt-12">
          <div className={`${STROKE_HEAD} mb-8`}>
            <span>Palette</span>
          </div>
          <div className={FIELD_ROW}>
            {document.palettes[0]?.colors.map((color) => (
              <button
                key={color}
                type="button"
                className={SWATCH}
                style={{ background: color }}
                aria-label={`Use ${color}`}
                onClick={() =>
                  patchSelection({ fill: { type: "solid", color } })
                }
              />
            ))}
          </div>
        </div>
      </PanelSection>
    </>
  );
}

export function Inspector() {
  const document = useDocument();
  const [activeView, setActiveView] = useState<"properties" | "layers">(
    "properties",
  );
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  // Selection may reach inside groups, so look nodes up directly.
  const selectedNodes = selectedNodeIds
    .map((id) => document.nodes[id])
    .filter((node): node is LogoNode => Boolean(node));
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0]! : null;
  const selectedClippingOwnerId =
    selectedNode
      ? getClippingMaskOwnerId(document, selectedNode.id)
      : null;
  const activeArtboard = document.artboards.find(
    (artboard) => artboard.id === document.activeArtboardId,
  );
  const layerObjectCount = activeArtboard
    ? collectLeafNodeIds(document, activeArtboard.nodeIds).length
    : 0;
  const ContextIcon = selectedNode ? NODE_ICONS[selectedNode.type] : Shapes;
  const contextTitle =
    selectedNode
      ? selectedNode.name
      : selectedNodes.length > 1
        ? `${selectedNodes.length} objects selected`
        : "Nothing selected";
  const contextMeta =
    selectedNode
      ? selectedNode.type === "path" && selectedNode.shape
        ? shapeDisplayName(selectedNode.shape.kind)
        : selectedNode.type[0]!.toUpperCase() + selectedNode.type.slice(1)
      : selectedNodes.length > 1
        ? "Selection"
        : "Canvas";

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const next = activeView === "properties" ? "layers" : "properties";
    setActiveView(next);
    requestAnimationFrame(() =>
      window.document.getElementById(`inspector-${next}-tab`)?.focus(),
    );
  }

  // Paint/typography patches always land on drawable leaves; a selected
  // group fans the patch out to its descendants.
  function patchSelection(patch: NodePatch) {
    const leafIds = collectLeafNodeIds(document, selectedNodeIds);
    if (leafIds.length === 0) {
      return;
    }
    documentStore.apply({
      type: "update-nodes",
      updates: leafIds.map((nodeId) => ({ nodeId, patch })),
    });
  }

  // Transient variant for in-flight drags (gradient stop chips): rides on
  // documentStore.preview, committed once by the matching patchSelection.
  function previewSelection(patch: NodePatch) {
    const leafIds = collectLeafNodeIds(document, selectedNodeIds);
    if (leafIds.length === 0) {
      return;
    }
    documentStore.preview(leafIds.map((nodeId) => ({ nodeId, patch })));
  }

  // Properties and layers each get the full rail. This keeps long gradient
  // controls readable and gives deep layer trees a stable, full-height target.
  return (
    <aside
      className="inspector flex min-h-0 flex-col overflow-hidden border-l border-panel-border bg-panel shadow-rail"
      aria-label="Inspector"
    >
      <header className="flex-none border-b border-panel-border bg-card/80 px-12 pb-10 pt-12 backdrop-blur-[10px]">
        <div className="mb-11 flex min-w-0 items-center gap-9">
          <span
            className="grid h-34 w-34 flex-none place-items-center rounded-[10px] border border-accent/16 bg-accent-soft text-accent"
            aria-hidden="true"
          >
            <ContextIcon size={15} strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <span className="mb-2 block text-[9.5px] font-[680] uppercase tracking-[0.09em] text-ink-dim">
              Inspector
            </span>
            <strong
              className="block truncate text-[13px] font-[650] text-ink"
              title={contextTitle}
            >
              {contextTitle}
            </strong>
          </div>
          <span className="max-w-92 truncate rounded-full bg-field px-7 py-3 text-[10px] text-ink-dim">
            {contextMeta}
          </span>
        </div>
        <div
          className="grid grid-cols-2 gap-3 rounded-m border border-field-border bg-field p-3"
          role="tablist"
          aria-label="Inspector views"
        >
          <button
            id="inspector-properties-tab"
            type="button"
            role="tab"
            className={`flex h-28 items-center justify-center gap-6 rounded-[6px] text-[11.5px] transition-[background-color,color,box-shadow] duration-140 ease-studio ${
              activeView === "properties"
                ? "bg-card font-semibold text-ink shadow-tab-lg"
                : "text-ink-dim hover:text-ink"
            }`}
            aria-selected={activeView === "properties"}
            aria-controls="inspector-properties-panel"
            tabIndex={activeView === "properties" ? 0 : -1}
            onKeyDown={handleTabKeyDown}
            onClick={() => setActiveView("properties")}
          >
            <SlidersHorizontal size={13} />
            Properties
          </button>
          <button
            id="inspector-layers-tab"
            type="button"
            role="tab"
            className={`flex h-28 items-center justify-center gap-6 rounded-[6px] text-[11.5px] transition-[background-color,color,box-shadow] duration-140 ease-studio ${
              activeView === "layers"
                ? "bg-card font-semibold text-ink shadow-tab-lg"
                : "text-ink-dim hover:text-ink"
            }`}
            aria-selected={activeView === "layers"}
            aria-controls="inspector-layers-panel"
            tabIndex={activeView === "layers" ? 0 : -1}
            onKeyDown={handleTabKeyDown}
            onClick={() => setActiveView("layers")}
          >
            <Layers3 size={13} />
            Layers
            <span
              className={`rounded-full px-5 py-1 text-[9.5px] tabular-nums ${
                activeView === "layers"
                  ? "bg-accent-soft text-accent-ink"
                  : "bg-card text-ink-dim"
              }`}
            >
              {layerObjectCount}
            </span>
          </button>
        </div>
      </header>

      <div
        id="inspector-properties-panel"
        role="tabpanel"
        aria-labelledby="inspector-properties-tab"
        className={`inspector-card min-h-0 flex-1 flex-col gap-9 overflow-y-auto p-10 ${
          activeView === "properties" ? "flex" : "hidden"
        }`}
      >
      {selectedNodes.length > 1 ? (
        <MultiDesignSection
          nodes={selectedNodes}
          patchSelection={patchSelection}
          previewSelection={previewSelection}
          cancelPreview={() => documentStore.cancelPreview()}
        />
      ) : selectedNodes.length === 1 && selectedNodes[0]!.type === "group" ? (
        <>
          <GroupSection group={selectedNodes[0] as GroupNode} />
          <EffectsSection node={selectedNodes[0]!} />
        </>
      ) : selectedNodes.length === 1 ? (
        <>
          {selectedClippingOwnerId && (
            <ClippingPathOwnershipSection
              ownerId={selectedClippingOwnerId}
            />
          )}
          <DesignSection
            node={selectedNodes[0]!}
            patchSelection={patchSelection}
            previewSelection={previewSelection}
            cancelPreview={() => documentStore.cancelPreview()}
          />
          <EffectsSection node={selectedNodes[0]!} />
        </>
      ) : (
        <section
          className={`${SECTION} grid justify-items-center gap-6 px-14 pb-18 pt-22 text-center`}
        >
          <span
            className="mb-4 grid h-34 w-34 place-items-center rounded-[10px] border border-accent/18 bg-[linear-gradient(135deg,var(--color-accent-soft),var(--color-accent-soft-2))] text-accent"
            aria-hidden="true"
          >
            <Shapes size={16} strokeWidth={1.75} />
          </span>
          <strong className="text-[12.5px] font-[650]">Nothing selected</strong>
          <p className="m-0 text-[11.5px] leading-[1.5] text-ink-dim">
            Select an object on the canvas to edit it,
            <br />
            or start drawing with the tools.
          </p>
          <div className="mt-12 grid grid-cols-[auto_auto] justify-center gap-x-10 gap-y-6">
            {(
              [
                ["V", "Select"],
                ["R", "Rectangle"],
                ["O", "Ellipse"],
                ["P", "Pen"],
                ["T", "Text"],
                ["⌘G", "Group"],
              ] as const
            ).map(([key, label]) => (
              <span
                key={key}
                className="flex items-center gap-7 text-[11px] text-ink-dim"
              >
                <kbd>{key}</kbd> {label}
              </span>
            ))}
          </div>
        </section>
      )}
      <SwatchesSection />
      </div>
      <div
        id="inspector-layers-panel"
        role="tabpanel"
        aria-labelledby="inspector-layers-tab"
        className={`inspector-card min-h-0 flex-1 flex-col overflow-y-auto p-10 ${
          activeView === "layers" ? "flex" : "hidden"
        }`}
      >
        <LayersSection />
      </div>
    </aside>
  );
}
