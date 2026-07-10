import { useRef, useState } from "react";
import { type Vec2, selectionFrame } from "@openlogo/core";
import { recordTransform } from "../lib/transform-again";
import { applyTransform } from "../lib/transform-ops";
import { documentStore } from "../state/document";
import { useEditorStore } from "../state/editor-store";
import { useModalDialog } from "../lib/use-modal-dialog";

type Mode = "rotate" | "reflect";
type Axis = "horizontal" | "vertical" | "angle";

const FIELD =
  "h-28 w-72 rounded-field border border-field-border bg-field px-8 text-[12.5px] tabular-nums text-ink outline-none transition-[border-color,box-shadow] duration-140 ease-studio focus:border-accent focus:bg-card focus:shadow-ring";
const TAB_BASE =
  "flex-1 rounded-[6px] py-5 text-[12px] transition-[background-color,color,box-shadow] duration-120 ease-studio";
const BUTTON =
  "rounded-field border border-field-border bg-card px-12 py-6 text-[12px] text-ink transition-[border-color,color] duration-140 ease-studio hover:enabled:border-accent hover:enabled:text-accent disabled:cursor-not-allowed disabled:opacity-45";
const PRIMARY =
  "rounded-field bg-accent px-12 py-6 text-[12px] font-semibold text-white transition-[filter] duration-140 ease-studio hover:enabled:brightness-[1.08] disabled:cursor-not-allowed disabled:opacity-45";

/** 9-point pivot ids, row-major: nw n ne / w c e / sw s se. */
const PIVOTS = ["nw", "n", "ne", "w", "c", "e", "sw", "s", "se"] as const;
const PIVOT_LABELS: Record<(typeof PIVOTS)[number], string> = {
  nw: "Top left",
  n: "Top center",
  ne: "Top right",
  w: "Center left",
  c: "Center",
  e: "Center right",
  sw: "Bottom left",
  s: "Bottom center",
  se: "Bottom right",
};
const TRANSFORM_DIALOG_TITLE_ID = "transform-dialog-title";

/**
 * Rotate / Reflect dialog (Illustrator Object → Transform): arbitrary
 * angle rotation or reflection across an H/V/angled axis, around a
 * 9-point pivot on the selection frame (default centre). Apply
 * transforms the selection; Copy transforms a duplicate and selects it.
 * Either way the transform records for ⌘D Transform Again.
 */
export function TransformDialog() {
  const open = useEditorStore((state) => state.transformDialogOpen);
  const setOpen = useEditorStore((state) => state.setTransformDialogOpen);
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const setSelection = useEditorStore((state) => state.setSelection);

  const [mode, setMode] = useState<Mode>("rotate");
  const [angle, setAngle] = useState("45");
  const [axis, setAxis] = useState<Axis>("vertical");
  const [axisAngle, setAxisAngle] = useState("0");
  const [pivotId, setPivotId] = useState<(typeof PIVOTS)[number]>("c");
  const dialogRef = useRef<HTMLDivElement>(null);
  const angleInputRef = useRef<HTMLInputElement>(null);

  useModalDialog({
    open,
    onClose: () => setOpen(false),
    dialogRef,
    initialFocusRef: angleInputRef,
  });

  if (!open) {
    return null;
  }

  function pivotPoint(): Vec2 | null {
    const frame = selectionFrame(documentStore.document, selectedNodeIds);
    if (!frame) {
      return null;
    }
    const index = PIVOTS.indexOf(pivotId);
    const col = index % 3;
    const row = Math.floor(index / 3);
    return {
      x: frame.bounds.x + (frame.bounds.width * col) / 2,
      y: frame.bounds.y + (frame.bounds.height * row) / 2,
    };
  }

  function run(copy: boolean) {
    const pivot = pivotPoint();
    if (!pivot) {
      setOpen(false);
      return;
    }

    const spec =
      mode === "rotate"
        ? ({ kind: "rotate", degrees: Number(angle) || 0, pivot } as const)
        : ({
            kind: "reflect",
            axisAngle:
              axis === "horizontal"
                ? 0
                : axis === "vertical"
                  ? 90
                  : Number(axisAngle) || 0,
            pivot,
          } as const);

    const ids = applyTransform(selectedNodeIds, spec, copy);
    if (ids) {
      recordTransform({ ...spec, copy });
      if (copy) {
        setSelection(ids);
      }
    }
    setOpen(false);
  }

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-40 grid place-items-center bg-[rgb(28_25_33/0.28)]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          setOpen(false);
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={TRANSFORM_DIALOG_TITLE_ID}
      tabIndex={-1}
    >
      <div className="w-[300px] rounded-panel border border-panel-hairline bg-panel p-16 shadow-panel">
        <h2 id={TRANSFORM_DIALOG_TITLE_ID} className="sr-only">
          Rotate or reflect
        </h2>
        <div
          className="mb-12 flex gap-2 rounded-m border border-field-border bg-field p-2"
          role="group"
          aria-label="Transform mode"
        >
          {(["rotate", "reflect"] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={`${TAB_BASE} ${
                mode === item
                  ? "bg-card font-semibold text-ink shadow-[0_1px_2px_rgb(28_25_33/0.1)]"
                  : "text-ink-dim"
              }`}
              onClick={() => setMode(item)}
              aria-pressed={mode === item}
            >
              {item === "rotate" ? "Rotate" : "Reflect"}
            </button>
          ))}
        </div>

        {mode === "rotate" ? (
          <label className="mb-12 flex items-center justify-between gap-8 text-[12px] text-ink-dim">
            Angle
            <span className="flex items-center gap-4">
              <input
                ref={angleInputRef}
                className={FIELD}
                type="number"
                value={angle}
                onChange={(event) => setAngle(event.target.value)}
                aria-label="Rotate angle"
              />
              °
            </span>
          </label>
        ) : (
          <div className="mb-12 grid gap-8">
            <label className="flex items-center justify-between gap-8 text-[12px] text-ink-dim">
              Axis
              <select
                className="h-28 rounded-field border border-field-border bg-field px-6 text-[12px] text-ink outline-none transition-[border-color,box-shadow] duration-140 ease-studio focus:border-accent focus:bg-card focus:shadow-ring"
                value={axis}
                onChange={(event) => setAxis(event.target.value as Axis)}
                aria-label="Reflect axis"
              >
                <option value="horizontal">Horizontal</option>
                <option value="vertical">Vertical</option>
                <option value="angle">Angle…</option>
              </select>
            </label>
            {axis === "angle" && (
              <label className="flex items-center justify-between gap-8 text-[12px] text-ink-dim">
                Axis angle
                <span className="flex items-center gap-4">
                  <input
                    className={FIELD}
                    type="number"
                    value={axisAngle}
                    onChange={(event) => setAxisAngle(event.target.value)}
                    aria-label="Reflect axis angle"
                  />
                  °
                </span>
              </label>
            )}
          </div>
        )}

        <div className="mb-14 flex items-center justify-between gap-8">
          <span className="text-[12px] text-ink-dim">Pivot</span>
          <div
            className="grid grid-cols-3 gap-3 rounded-m border border-field-border bg-field p-4"
            role="group"
            aria-label="Transform pivot"
          >
            {PIVOTS.map((id) => (
              <button
                key={id}
                type="button"
                className="grid h-24 w-24 place-items-center rounded-[5px]"
                onClick={() => setPivotId(id)}
                title={`Pivot: ${PIVOT_LABELS[id]}`}
                aria-label={`Pivot: ${PIVOT_LABELS[id]}`}
                aria-pressed={pivotId === id}
              >
                <i
                  aria-hidden="true"
                  className={`h-7 w-7 rounded-full ${
                    pivotId === id ? "bg-accent" : "bg-[rgb(28_25_33/0.25)]"
                  }`}
                />
              </button>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-8">
          <button type="button" className={BUTTON} onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={() => run(true)}
            aria-label="Transform copy"
            disabled={selectedNodeIds.length === 0}
          >
            Copy
          </button>
          <button
            type="button"
            className={PRIMARY}
            onClick={() => run(false)}
            aria-label="Apply transform"
            disabled={selectedNodeIds.length === 0}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
