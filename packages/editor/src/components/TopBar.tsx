import { useEffect, useRef, useState } from "react";
import { Effect } from "effect";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Combine,
  Copy,
  Download,
  FolderKanban,
  FolderOpen,
  Magnet,
  Pencil,
  Plus,
  Save,
  Upload,
  Redo2,
  SquaresExclude,
  SquaresIntersect,
  SquaresSubtract,
  SquaresUnite,
  Trash2,
  Unlink,
  Undo2,
} from "lucide-react";
import {
  type Artboard,
  type LogoVariant,
  cloneArtboardForVariant,
  createArtboard,
  getActiveArtboard,
  nextArtboardPosition,
} from "@openlogo/core";
import { type BooleanOp, fitBounds } from "@openlogo/renderer";
import { applyBooleanOp, combinableNodes } from "../lib/boolean-ops";
import { cancelActiveCanvasSessions } from "../lib/canvas-sessions";
import {
  canMakeCompoundPath,
  canReleaseCompoundPath,
  makeCompoundPath,
  releaseCompoundPath,
} from "../lib/compound-path";
import {
  openDocumentFileWithToast,
  saveDocumentFile,
} from "../lib/document-file";
import { exportPack } from "../lib/export-pack";
import { deleteSelection as deleteSelectedUnits } from "../lib/group-ops";
import { MAX_SVG_IMPORT_BYTES, importSvg } from "../lib/svg-import";
import { documentStore, useDocument } from "../state/document";
import { useEditorStore } from "../state/editor-store";

const BOOLEAN_OPS: Array<{
  id: BooleanOp;
  label: string;
  icon: typeof SquaresUnite;
}> = [
  { id: "union", label: "Union", icon: SquaresUnite },
  { id: "subtract", label: "Subtract", icon: SquaresSubtract },
  { id: "intersect", label: "Intersect", icon: SquaresIntersect },
  { id: "exclude", label: "Exclude", icon: SquaresExclude },
];

const VARIANTS: Array<{ id: LogoVariant; label: string }> = [
  { id: "icon", label: "Icon" },
  { id: "wordmark", label: "Wordmark" },
  { id: "horizontal", label: "Horizontal" },
  { id: "stacked", label: "Stacked" },
];

function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onOutside();
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [onOutside]);

  return ref;
}

const ICON_BUTTON =
  "icon-button grid h-30 w-30 place-items-center rounded-m text-chrome-dim transition-colors duration-140 ease-studio hover:enabled:bg-chrome-raised hover:enabled:text-chrome-text disabled:cursor-default disabled:opacity-30";

/** Hover-revealed row action (rename/duplicate/move/delete). */
const ACTION_BUTTON =
  "grid h-22 w-22 place-items-center rounded-[6px] text-chrome-dim transition-colors duration-120 ease-studio hover:enabled:bg-chrome-raised hover:enabled:text-chrome-text disabled:cursor-default disabled:opacity-35";

const SESSION_STATUS = {
  loading: { label: "Restoring…", dot: "bg-chrome-dim" },
  saving: { label: "Saving…", dot: "bg-amber-400" },
  saved: { label: "Saved locally", dot: "bg-emerald-400" },
  error: { label: "Save issue", dot: "bg-red-400" },
} as const;

function DocumentSessionStatus() {
  const state = useEditorStore((editor) => editor.documentSessionState);
  const status = SESSION_STATUS[state];

  return (
    <span
      className="flex h-30 items-center gap-6 rounded-m border border-chrome-hairline bg-[rgb(255_255_255/0.025)] px-8 text-[11px] text-chrome-dim"
      role="status"
      aria-live="polite"
      title="Local document status"
    >
      <span className={`h-6 w-6 rounded-full ${status.dot}`} aria-hidden="true" />
      {status.label}
    </span>
  );
}

const ARTBOARD_PRESETS = [
  { label: "Logo", width: 720, height: 420 },
  { label: "Square", width: 1080, height: 1080 },
  { label: "Icon", width: 512, height: 512 },
  { label: "Social", width: 1200, height: 630 },
  { label: "Story", width: 1080, height: 1920 },
];

const MAX_ARTBOARD_DIMENSION = 16_384;

function normalizeArtboardDimension(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  return rounded >= 1 && rounded <= MAX_ARTBOARD_DIMENSION ? rounded : null;
}

/** Fit the camera to an artboard (new/switched); no-op before first layout. */
function fitCameraTo(artboardId: string) {
  const state = useEditorStore.getState();
  const target = documentStore.document.artboards.find(
    (item) => item.id === artboardId,
  );
  if (target && state.viewport.width > 0) {
    state.setCamera(
      fitBounds(target, state.viewport.width, state.viewport.height),
    );
  }
}

/**
 * Scroll (never zoom) just enough to bring an artboard into view; no-op
 * when it is already fully visible. New/duplicated boards land adjacent
 * to their anchor, so the camera must not jump — only reveal.
 */
function ensureArtboardVisible(artboardId: string) {
  const state = useEditorStore.getState();
  const target = documentStore.document.artboards.find(
    (item) => item.id === artboardId,
  );
  if (!target || state.viewport.width === 0) {
    return;
  }

  const { camera, viewport } = state;
  const viewWidth = viewport.width / camera.zoom;
  const viewHeight = viewport.height / camera.zoom;
  const margin = 24 / camera.zoom;

  let ox = camera.offset.x;
  let oy = camera.offset.y;
  // Minimal nudge per axis; a board wider/taller than the viewport keeps
  // its near (top-left) edge visible.
  if (target.x - margin < ox) {
    ox = target.x - margin;
  } else if (target.x + target.width + margin > ox + viewWidth) {
    ox = Math.min(target.x - margin, target.x + target.width + margin - viewWidth);
  }
  if (target.y - margin < oy) {
    oy = target.y - margin;
  } else if (target.y + target.height + margin > oy + viewHeight) {
    oy = Math.min(target.y - margin, target.y + target.height + margin - viewHeight);
  }

  if (ox !== camera.offset.x || oy !== camera.offset.y) {
    state.setCamera({ ...camera, offset: { x: ox, y: oy } });
  }
}

function ArtboardRenameField({
  artboard,
  onDone,
}: {
  artboard: Artboard;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(artboard.name);

  function commit() {
    const name = draft.trim();
    if (name && name !== artboard.name) {
      documentStore.apply({
        type: "update-artboard",
        artboardId: artboard.id,
        patch: { name },
      });
    }
    onDone();
  }

  return (
    <input
      className="artboard-rename h-22 min-w-0 flex-1 rounded-[5px] border border-accent bg-chrome-raised px-6 text-[12px] text-chrome-text shadow-ring outline-none"
      value={draft}
      autoFocus
      aria-label="Artboard name"
      onFocus={(event) => event.target.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          (event.target as HTMLInputElement).blur();
        } else if (event.key === "Escape") {
          onDone();
        }
      }}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

function ArtboardMenu() {
  const document = useDocument();
  const setSelection = useEditorStore((state) => state.setSelection);
  const setToast = useEditorStore((state) => state.setToast);
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [customWidth, setCustomWidth] = useState("720");
  const [customHeight, setCustomHeight] = useState("420");
  const ref = useClickOutside(() => {
    setOpen(false);
    setConfirmDeleteId(null);
    setRenamingId(null);
  });
  const artboard = getActiveArtboard(document);

  function activate(artboardId: string) {
    documentStore.apply({ type: "set-active-artboard", artboardId });
    setSelection([]);
    fitCameraTo(artboardId);
    setOpen(false);
  }

  function addArtboard(width: number, height: number) {
    const normalizedWidth = normalizeArtboardDimension(width);
    const normalizedHeight = normalizeArtboardDimension(height);
    if (normalizedWidth === null || normalizedHeight === null) {
      setToast(
        `Artboards must be between 1 and ${MAX_ARTBOARD_DIMENSION.toLocaleString()} px per side.`,
      );
      return;
    }

    const doc = documentStore.document;
    const size = {
      width: normalizedWidth,
      height: normalizedHeight,
    };
    // Illustrator-style: the new board joins the shared canvas right next
    // to the board you are working in, and becomes the active one.
    const board = createArtboard("primary", {
      name: `Artboard ${doc.artboards.length + 1}`,
      ...nextArtboardPosition(doc, doc.activeArtboardId, size),
      ...size,
    });
    documentStore.apply({ type: "add-artboard", artboard: board, nodes: [] });
    setSelection([]);
    ensureArtboardVisible(board.id);
    setOpen(false);
  }

  function duplicateArtboard(artboardId: string) {
    const doc = documentStore.document;
    const source = doc.artboards.find((item) => item.id === artboardId);
    if (!source) {
      return;
    }
    const { artboard: clone, nodes } = cloneArtboardForVariant(
      doc,
      artboardId,
      source.purpose,
    );
    clone.name = `${source.name} copy`;
    const position = nextArtboardPosition(doc, artboardId, {
      width: clone.width,
      height: clone.height,
    });
    clone.x = position.x;
    clone.y = position.y;
    documentStore.apply({
      type: "add-artboard",
      artboard: clone,
      nodes,
      index: doc.artboards.indexOf(source) + 1,
    });
    setSelection([]);
    ensureArtboardVisible(clone.id);
    setOpen(false);
  }

  function moveArtboard(artboardId: string, delta: -1 | 1) {
    const artboards = documentStore.document.artboards;
    const index = artboards.findIndex((item) => item.id === artboardId);
    const toIndex = index + delta;
    if (index === -1 || toIndex < 0 || toIndex >= artboards.length) {
      return;
    }
    documentStore.apply({ type: "reorder-artboard", artboardId, toIndex });
  }

  function deleteArtboard(artboardId: string) {
    // Two-step inline confirm — no blocking dialog.
    if (confirmDeleteId !== artboardId) {
      setConfirmDeleteId(artboardId);
      return;
    }
    setConfirmDeleteId(null);
    documentStore.apply({ type: "remove-artboard", artboardId });
    setSelection([]);
    fitCameraTo(documentStore.document.activeArtboardId);
  }

  function createVariant(purpose: LogoVariant) {
    const doc = documentStore.document;
    const { artboard: next, nodes } = cloneArtboardForVariant(
      doc,
      doc.activeArtboardId,
      purpose,
    );
    const position = nextArtboardPosition(doc, doc.activeArtboardId, {
      width: next.width,
      height: next.height,
    });
    next.x = position.x;
    next.y = position.y;
    documentStore.apply({ type: "add-artboard", artboard: next, nodes });
    setSelection([]);
    ensureArtboardVisible(next.id);
    setOpen(false);
  }

  const canDelete = document.artboards.length > 1;
  const normalizedCustomWidth = normalizeArtboardDimension(
    Number(customWidth),
  );
  const normalizedCustomHeight = normalizeArtboardDimension(
    Number(customHeight),
  );
  const customSizeValid =
    normalizedCustomWidth !== null && normalizedCustomHeight !== null;

  return (
    <div className="menu-anchor relative" ref={ref}>
      <button
        type="button"
        className="topbar-select flex items-center gap-8 rounded-m px-9 py-5 text-chrome-text transition-colors duration-140 ease-studio hover:bg-chrome-raised"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span>{artboard.name}</span>
        <small className="text-[11px] tabular-nums text-chrome-dim">
          {artboard.width} × {artboard.height}
        </small>
        <ChevronDown size={14} className="text-chrome-dim" />
      </button>

      {open && (
        <div className="menu menu-artboards" role="menu">
          <div className="menu-heading">Artboards</div>
          <div className="artboard-list max-h-[264px] overflow-y-auto overscroll-contain">
            {document.artboards.map((item, index) => (
              <div
                key={item.id}
                className={`artboard-row group flex items-center gap-2 rounded-[7px]${
                  item.id === document.activeArtboardId ? " active" : ""
                }`}
              >
                <button
                  type="button"
                  className="menu-item artboard-activate min-w-0 flex-1"
                  onClick={() => activate(item.id)}
                >
                  <span className="menu-check">
                    {item.id === document.activeArtboardId && (
                      <Check size={13} />
                    )}
                  </span>
                  {renamingId === item.id ? (
                    <ArtboardRenameField
                      artboard={item}
                      onDone={() => setRenamingId(null)}
                    />
                  ) : (
                    <span className="menu-label truncate">{item.name}</span>
                  )}
                  <small className="normal-case tabular-nums">
                    {item.width}×{item.height}
                  </small>
                </button>
                {/* Revealed on hover/focus via opacity (not display) so the
                    buttons stay keyboard-focusable and hit-testable. */}
                <span className="artboard-actions flex shrink-0 items-center gap-1 pr-2 opacity-0 transition-opacity duration-120 ease-studio group-focus-within:opacity-100 group-hover:opacity-100">
                  <button
                    type="button"
                    className={ACTION_BUTTON}
                    onClick={() => setRenamingId(item.id)}
                    title="Rename"
                    aria-label={`Rename ${item.name}`}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    className={ACTION_BUTTON}
                    onClick={() => duplicateArtboard(item.id)}
                    title="Duplicate"
                    aria-label={`Duplicate ${item.name}`}
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    type="button"
                    className={ACTION_BUTTON}
                    onClick={() => moveArtboard(item.id, -1)}
                    disabled={index === 0}
                    title="Move up"
                    aria-label={`Move ${item.name} up`}
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    type="button"
                    className={ACTION_BUTTON}
                    onClick={() => moveArtboard(item.id, 1)}
                    disabled={index === document.artboards.length - 1}
                    title="Move down"
                    aria-label={`Move ${item.name} down`}
                  >
                    <ChevronDown size={12} />
                  </button>
                  <button
                    type="button"
                    className={`${ACTION_BUTTON}${
                      confirmDeleteId === item.id
                        ? " is-confirming bg-[#ef4444] text-white"
                        : ""
                    }`}
                    onClick={() => deleteArtboard(item.id)}
                    disabled={!canDelete}
                    title={
                      confirmDeleteId === item.id
                        ? "Click again to delete"
                        : "Delete"
                    }
                    aria-label={
                      confirmDeleteId === item.id
                        ? `Confirm delete ${item.name}`
                        : `Delete ${item.name}`
                    }
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </div>
            ))}
          </div>

          <div className="menu-divider" />
          <div className="menu-heading">New artboard</div>
          <div className="grid grid-cols-3 gap-4 px-4 pb-6 pt-2">
            {ARTBOARD_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="flex flex-col items-start gap-1 rounded-[7px] border border-chrome-border bg-chrome-raised px-8 py-6 transition-colors duration-120 ease-studio hover:border-[#8ea0fa]"
                onClick={() => addArtboard(preset.width, preset.height)}
                aria-label={`Add ${preset.label} artboard ${preset.width}×${preset.height}`}
              >
                <span className="text-[11.5px] font-semibold">{preset.label}</span>
                <small className="text-[10px] tabular-nums text-chrome-dim">
                  {preset.width}×{preset.height}
                </small>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-5 px-4 pb-4">
            <input
              type="number"
              min="1"
              max={MAX_ARTBOARD_DIMENSION}
              step="1"
              className="h-24 w-62 rounded-[6px] border border-chrome-border bg-chrome-raised px-6 text-[11.5px] tabular-nums text-chrome-text outline-none focus:border-accent focus:shadow-ring"
              value={customWidth}
              onChange={(event) => setCustomWidth(event.target.value)}
              aria-label="Custom artboard width"
              aria-invalid={normalizedCustomWidth === null}
            />
            <span className="text-[11px] text-chrome-dim">×</span>
            <input
              type="number"
              min="1"
              max={MAX_ARTBOARD_DIMENSION}
              step="1"
              className="h-24 w-62 rounded-[6px] border border-chrome-border bg-chrome-raised px-6 text-[11.5px] tabular-nums text-chrome-text outline-none focus:border-accent focus:shadow-ring"
              value={customHeight}
              onChange={(event) => setCustomHeight(event.target.value)}
              aria-label="Custom artboard height"
              aria-invalid={normalizedCustomHeight === null}
            />
            <button
              type="button"
              className="ml-auto inline-flex h-24 items-center gap-4 rounded-[6px] bg-linear-to-b from-[#5d77f7] to-accent px-9 text-[11.5px] font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.24)] hover:brightness-[1.08]"
              onClick={() => {
                if (customSizeValid) {
                  addArtboard(normalizedCustomWidth, normalizedCustomHeight);
                }
              }}
              disabled={!customSizeValid}
              title={
                customSizeValid
                  ? "Add custom artboard"
                  : `Use 1–${MAX_ARTBOARD_DIMENSION.toLocaleString()} px per side`
              }
              aria-label="Add custom artboard"
            >
              <Plus size={12} /> Add
            </button>
          </div>

          <div className="menu-divider" />
          <div className="menu-heading">New variant</div>
          {VARIANTS.map((variant) => (
            <button
              key={variant.id}
              type="button"
              className="menu-item"
              onClick={() => createVariant(variant.id)}
            >
              <span className="menu-check">
                <Plus size={13} />
              </span>
              <span className="menu-label">{variant.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ExportMenu() {
  const [open, setOpen] = useState(false);
  const [exportingPack, setExportingPack] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const setExportDialogOpen = useEditorStore(
    (state) => state.setExportDialogOpen,
  );
  const setToast = useEditorStore((state) => state.setToast);

  return (
    <div className="menu-anchor relative" ref={ref}>
      <button
        type="button"
        data-export-dialog-trigger
        className="export-button flex items-center gap-7 rounded-[9px] bg-linear-to-b from-[#5d77f7] to-accent px-13 py-7 text-[12.5px] font-semibold text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.22),0_1px_3px_rgb(8_6_12/0.45)] transition-[filter] duration-140 ease-studio hover:brightness-[1.09]"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <Download size={15} />
        <span>Export</span>
        <ChevronDown size={13} />
      </button>

      {open && (
        <div className="menu menu-right" role="menu">
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setExportDialogOpen(true);
              setOpen(false);
            }}
          >
            <span className="menu-label">Export…</span>
            <small>boards · svg · png · ico</small>
          </button>
          <div className="menu-divider" />
          <button
            type="button"
            className="menu-item"
            disabled={exportingPack}
            onClick={() => {
              setOpen(false);
              setExportingPack(true);
              void Effect.runPromise(exportPack)
                .catch((error: unknown) => {
                  console.warn("Export pack failed", error);
                  setToast(
                    error &&
                      typeof error === "object" &&
                      "reason" in error &&
                      typeof error.reason === "string"
                      ? error.reason
                      : "Export pack failed — try a smaller artboard.",
                  );
                })
                .finally(() => setExportingPack(false));
            }}
          >
            <span className="menu-label">
              {exportingPack ? "Preparing…" : "Export pack"}
            </span>
            <small>svg · mono · reversed · favicons</small>
          </button>
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const document = useDocument(); // re-render on history/name changes
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const setSelection = useEditorStore((state) => state.setSelection);
  const pixelSnap = useEditorStore((state) => state.pixelSnap);
  const setPixelSnap = useEditorStore((state) => state.setPixelSnap);
  const setToast = useEditorStore((state) => state.setToast);
  const setDocumentLibraryOpen = useEditorStore(
    (state) => state.setDocumentLibraryOpen,
  );
  const canCombine = combinableNodes(selectedNodeIds).length >= 2;
  const canCompound = canMakeCompoundPath(selectedNodeIds);
  const canReleaseCompound = canReleaseCompoundPath(selectedNodeIds);

  async function runBoolean(op: BooleanOp) {
    try {
      const newId = await applyBooleanOp(op, selectedNodeIds);
      if (newId) {
        setSelection([newId]);
      } else {
        setToast("Those shapes could not be combined.");
      }
    } catch (error) {
      console.warn("Boolean operation failed", error);
      setToast("Boolean operation failed. The original shapes were preserved.");
    }
  }

  async function runCompound() {
    try {
      const newId = await makeCompoundPath(selectedNodeIds);
      if (newId) {
        setSelection([newId]);
      } else {
        setToast("Select two or more sibling vector shapes.");
      }
    } catch (error) {
      console.warn("Compound path failed", error);
      setToast("Compound path failed. The original shapes were preserved.");
    }
  }

  function runReleaseCompound() {
    try {
      const ids = releaseCompoundPath(selectedNodeIds);
      if (ids) {
        setSelection(ids);
      } else {
        setToast("Select one editable compound path.");
      }
    } catch (error) {
      console.warn("Release compound path failed", error);
      setToast(
        "Release compound path failed. The original path was preserved.",
      );
    }
  }

  function deleteSelection() {
    if (selectedNodeIds.length === 0) {
      return;
    }
    deleteSelectedUnits(selectedNodeIds);
    setSelection([]);
  }

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const openInputRef = useRef<HTMLInputElement | null>(null);

  async function handleImportFile(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    if (file.size > MAX_SVG_IMPORT_BYTES) {
      setToast("SVG import is limited to 5 MB for reliable local editing.");
      return;
    }

    try {
      const ids = await Effect.runPromise(importSvg(await file.text()));
      if (ids.length > 0) {
        setSelection(ids);
      } else {
        setToast("This SVG contains no supported editable shapes.");
      }
    } catch (error) {
      console.warn("SVG import failed", error);
      setToast(
        error &&
          typeof error === "object" &&
          "reason" in error &&
          typeof error.reason === "string"
          ? error.reason
          : "SVG import failed. The current document was not changed.",
      );
    }
  }

  function handleOpenFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) {
      openDocumentFileWithToast(file);
    }
  }

  return (
    <header className="topbar flex items-center justify-between gap-16 border-b border-[rgb(0_0_0/0.5)] bg-linear-to-b from-[#1a1820] to-chrome pl-10 pr-16 text-chrome-text shadow-[inset_0_-1px_0_var(--color-chrome-hairline)]">
      <div className="flex items-center gap-8">
        {/* Brand mark + wordmark + artboard pill read as one designed cluster. */}
        <div className="flex items-center gap-10 rounded-[11px] border border-chrome-hairline bg-[rgb(255_255_255/0.035)] py-4 pl-5 pr-6">
          <span className="grid h-26 w-26 place-items-center rounded-m bg-[linear-gradient(135deg,#6a82f8,var(--color-accent)_55%,var(--color-accent-deep))] text-[11px] font-extrabold tracking-[-0.05em] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.28),0_1px_3px_rgb(8_6_12/0.4)]">
            OL
          </span>
          <span className="text-[13px] font-[650] tracking-[-0.01em]">
            OpenLogo
          </span>
          <span className="h-18 w-px bg-chrome-border" />
          <button
            type="button"
            className="flex h-28 items-center gap-6 rounded-m px-7 text-[11.5px] text-chrome-dim transition-colors duration-140 ease-studio hover:bg-chrome-raised hover:text-chrome-text"
            onClick={() => setDocumentLibraryOpen(true)}
            title="Document library and version history"
            aria-label="Open document library and version history"
          >
            <FolderKanban size={14} strokeWidth={1.75} />
            <span className="hidden max-w-[140px] truncate lg:inline">
              {document.name}
            </span>
          </button>
          <span className="h-18 w-px bg-chrome-border" />
          <ArtboardMenu />
        </div>
      </div>

      <div className="flex items-center gap-8">
        <div
          className="flex items-center gap-2 rounded-[10px] border border-chrome-hairline bg-[rgb(255_255_255/0.035)] p-3"
          role="group"
          aria-label="Path operations"
        >
          <button
            type="button"
            className={ICON_BUTTON}
            onClick={() => void runCompound()}
            disabled={!canCompound}
            title="Make compound path (⌘8)"
            aria-label="Make compound path"
          >
            <Combine size={16} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            className={ICON_BUTTON}
            onClick={runReleaseCompound}
            disabled={!canReleaseCompound}
            title="Release compound path (⌥⇧⌘8 / Alt+Shift+Ctrl+8)"
            aria-label="Release compound path"
          >
            <Unlink size={16} strokeWidth={1.75} />
          </button>
          <span
            className="mx-2 h-18 w-px bg-chrome-border"
            aria-hidden="true"
          />
          {BOOLEAN_OPS.map((op) => {
            const Icon = op.icon;
            return (
              <button
                key={op.id}
                type="button"
                className={ICON_BUTTON}
                onClick={() => void runBoolean(op.id)}
                disabled={!canCombine}
                title={`${op.label} selected shapes`}
                aria-label={op.label}
              >
                <Icon size={16} strokeWidth={1.75} />
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-8">
        <DocumentSessionStatus />
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={() => {
            cancelActiveCanvasSessions();
            documentStore.undo();
            setSelection([]);
          }}
          disabled={!documentStore.canUndo}
          title="Undo (⌘Z)"
          aria-label="Undo"
        >
          <Undo2 size={16} />
        </button>
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={() => {
            cancelActiveCanvasSessions();
            documentStore.redo();
            setSelection([]);
          }}
          disabled={!documentStore.canRedo}
          title="Redo (⇧⌘Z)"
          aria-label="Redo"
        >
          <Redo2 size={16} />
        </button>
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={deleteSelection}
          disabled={selectedNodeIds.length === 0}
          title="Delete selection"
          aria-label="Delete selection"
        >
          <Trash2 size={16} />
        </button>
        <button
          type="button"
          className={`${ICON_BUTTON}${
            pixelSnap ? " bg-chrome-raised !text-accent" : ""
          }`}
          onClick={() => setPixelSnap(!pixelSnap)}
          title="Pixel snap: round committed positions and sizes to whole pixels"
          aria-label="Pixel snap"
          aria-pressed={pixelSnap}
        >
          <Magnet size={16} />
        </button>
        <div className="mx-4 h-20 w-px bg-chrome-border" />
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={() => openInputRef.current?.click()}
          title="Open .openlogo document (⌘O)"
          aria-label="Open document"
        >
          <FolderOpen size={16} />
        </button>
        <input
          ref={openInputRef}
          type="file"
          accept=".openlogo,application/json"
          style={{ display: "none" }}
          data-testid="open-document-input"
          onChange={handleOpenFile}
        />
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={saveDocumentFile}
          title="Save as .openlogo (⌘S)"
          aria-label="Save document"
        >
          <Save size={16} />
        </button>
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={() => fileInputRef.current?.click()}
          title="Import SVG"
          aria-label="Import SVG"
        >
          <Upload size={16} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".svg,image/svg+xml"
          style={{ display: "none" }}
          onChange={(event) => void handleImportFile(event)}
        />
        <ExportMenu />
      </div>
    </header>
  );
}
