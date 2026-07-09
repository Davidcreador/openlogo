import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Pencil,
  Plus,
  Upload,
  Redo2,
  SquaresExclude,
  SquaresIntersect,
  SquaresSubtract,
  SquaresUnite,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  type Artboard,
  type LogoVariant,
  cloneArtboardForVariant,
  createArtboard,
  getActiveArtboard,
} from "@openlogo/core";
import { type BooleanOp, fitBounds } from "@openlogo/renderer";
import { applyBooleanOp, combinableNodes } from "../lib/boolean-ops";
import {
  documentToSvg,
  downloadPngFromSvg,
  downloadTextFile,
} from "../lib/export";
import { exportPack } from "../lib/export-pack";
import { importSvg } from "../lib/svg-import";
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

const ARTBOARD_PRESETS = [
  { label: "Logo", width: 720, height: 420 },
  { label: "Square", width: 1080, height: 1080 },
  { label: "Icon", width: 512, height: 512 },
  { label: "Social", width: 1200, height: 630 },
  { label: "Story", width: 1080, height: 1920 },
];

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

/** X for a new artboard: clear of everything, to the right. */
function nextArtboardX(): number {
  const artboards = documentStore.document.artboards;
  return Math.max(...artboards.map((item) => item.x + item.width)) + 120;
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
      className="artboard-rename"
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
    const board = createArtboard("primary", {
      name: `Artboard ${documentStore.document.artboards.length + 1}`,
      x: nextArtboardX(),
      y: documentStore.document.artboards[0]?.y ?? 0,
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    });
    documentStore.apply({ type: "add-artboard", artboard: board, nodes: [] });
    setSelection([]);
    fitCameraTo(board.id);
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
    clone.x = nextArtboardX();
    clone.y = source.y;
    documentStore.apply({
      type: "add-artboard",
      artboard: clone,
      nodes,
      index: doc.artboards.indexOf(source) + 1,
    });
    setSelection([]);
    fitCameraTo(clone.id);
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
    const { artboard: next, nodes } = cloneArtboardForVariant(
      documentStore.document,
      documentStore.document.activeArtboardId,
      purpose,
    );
    documentStore.apply({ type: "add-artboard", artboard: next, nodes });
    setSelection([]);
    fitCameraTo(next.id);
    setOpen(false);
  }

  const canDelete = document.artboards.length > 1;

  return (
    <div className="menu-anchor" ref={ref}>
      <button
        type="button"
        className="topbar-select"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span>{artboard.name}</span>
        <small>
          {artboard.width} × {artboard.height}
        </small>
        <ChevronDown size={14} />
      </button>

      {open && (
        <div className="menu menu-artboards" role="menu">
          <div className="menu-heading">Artboards</div>
          <div className="artboard-list">
            {document.artboards.map((item, index) => (
              <div
                key={item.id}
                className={`artboard-row${
                  item.id === document.activeArtboardId ? " active" : ""
                }`}
              >
                <button
                  type="button"
                  className="menu-item artboard-activate"
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
                    <span className="menu-label">{item.name}</span>
                  )}
                  <small>
                    {item.width}×{item.height}
                  </small>
                </button>
                <span className="artboard-actions">
                  <button
                    type="button"
                    onClick={() => setRenamingId(item.id)}
                    title="Rename"
                    aria-label={`Rename ${item.name}`}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => duplicateArtboard(item.id)}
                    title="Duplicate"
                    aria-label={`Duplicate ${item.name}`}
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveArtboard(item.id, -1)}
                    disabled={index === 0}
                    title="Move up"
                    aria-label={`Move ${item.name} up`}
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveArtboard(item.id, 1)}
                    disabled={index === document.artboards.length - 1}
                    title="Move down"
                    aria-label={`Move ${item.name} down`}
                  >
                    <ChevronDown size={12} />
                  </button>
                  <button
                    type="button"
                    className={
                      confirmDeleteId === item.id ? "is-confirming" : ""
                    }
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
          <div className="artboard-presets">
            {ARTBOARD_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="artboard-preset"
                onClick={() => addArtboard(preset.width, preset.height)}
                aria-label={`Add ${preset.label} artboard ${preset.width}×${preset.height}`}
              >
                <span>{preset.label}</span>
                <small>
                  {preset.width}×{preset.height}
                </small>
              </button>
            ))}
          </div>
          <div className="artboard-custom">
            <input
              type="number"
              min="1"
              value={customWidth}
              onChange={(event) => setCustomWidth(event.target.value)}
              aria-label="Custom artboard width"
            />
            <span>×</span>
            <input
              type="number"
              min="1"
              value={customHeight}
              onChange={(event) => setCustomHeight(event.target.value)}
              aria-label="Custom artboard height"
            />
            <button
              type="button"
              onClick={() => {
                const width = Number(customWidth);
                const height = Number(customHeight);
                if (width > 0 && height > 0) {
                  addArtboard(width, height);
                }
              }}
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
  const document = useDocument();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const artboard = getActiveArtboard(document);
  const baseName = artboard.name.toLowerCase().replaceAll(" ", "-");

  return (
    <div className="menu-anchor" ref={ref}>
      <button
        type="button"
        className="export-button"
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
              downloadTextFile(
                documentToSvg(documentStore.document),
                `${baseName}.svg`,
                "image/svg+xml",
              );
              setOpen(false);
            }}
          >
            <span className="menu-label">SVG (vector)</span>
          </button>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              void downloadPngFromSvg(
                documentToSvg(documentStore.document),
                `${baseName}@2x.png`,
                artboard.width,
                artboard.height,
              );
              setOpen(false);
            }}
          >
            <span className="menu-label">PNG (2×)</span>
          </button>
          <div className="menu-divider" />
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              void exportPack();
              setOpen(false);
            }}
          >
            <span className="menu-label">Export pack</span>
            <small>svg · mono · reversed · favicons</small>
          </button>
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  useDocument(); // re-render on history/name changes
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const setSelection = useEditorStore((state) => state.setSelection);
  const canCombine = combinableNodes(selectedNodeIds).length >= 2;

  async function runBoolean(op: BooleanOp) {
    const newId = await applyBooleanOp(op, selectedNodeIds);
    if (newId) {
      setSelection([newId]);
    }
  }

  function deleteSelection() {
    if (selectedNodeIds.length === 0) {
      return;
    }
    documentStore.apply({ type: "delete-nodes", nodeIds: selectedNodeIds });
    setSelection([]);
  }

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function handleImportFile(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    const ids = await importSvg(await file.text());
    if (ids.length > 0) {
      setSelection(ids);
    }
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand-cluster">
          <span className="topbar-mark">OL</span>
          <span className="topbar-title">OpenLogo</span>
          <span className="brand-divider" />
          <ArtboardMenu />
        </div>
      </div>

      <div className="topbar-center">
        <div className="topbar-tools" role="group" aria-label="Boolean operations">
          {BOOLEAN_OPS.map((op) => {
            const Icon = op.icon;
            return (
              <button
                key={op.id}
                type="button"
                className="icon-button"
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

      <div className="topbar-right">
        <button
          type="button"
          className="icon-button"
          onClick={() => {
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
          className="icon-button"
          onClick={() => {
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
          className="icon-button"
          onClick={deleteSelection}
          disabled={selectedNodeIds.length === 0}
          title="Delete selection"
          aria-label="Delete selection"
        >
          <Trash2 size={16} />
        </button>
        <div className="topbar-separator" />
        <button
          type="button"
          className="icon-button"
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
