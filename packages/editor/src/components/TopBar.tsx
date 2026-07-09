import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Download,
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
import { type LogoVariant, cloneArtboardForVariant, getActiveArtboard } from "@openlogo/core";
import type { BooleanOp } from "@openlogo/renderer";
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

function ArtboardMenu() {
  const document = useDocument();
  const setSelection = useEditorStore((state) => state.setSelection);
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const artboard = getActiveArtboard(document);

  function activate(artboardId: string) {
    documentStore.apply({ type: "set-active-artboard", artboardId });
    setSelection([]);
    setOpen(false);
  }

  function createVariant(purpose: LogoVariant) {
    const { artboard: next, nodes } = cloneArtboardForVariant(
      documentStore.document,
      documentStore.document.activeArtboardId,
      purpose,
    );
    documentStore.apply({ type: "add-artboard", artboard: next, nodes });
    setSelection([]);
    setOpen(false);
  }

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
        <div className="menu" role="menu">
          <div className="menu-heading">Artboards</div>
          {document.artboards.map((item) => (
            <button
              key={item.id}
              type="button"
              className="menu-item"
              onClick={() => activate(item.id)}
            >
              <span className="menu-check">
                {item.id === document.activeArtboardId && <Check size={13} />}
              </span>
              <span className="menu-label">{item.name}</span>
              <small>{item.purpose}</small>
            </button>
          ))}
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
