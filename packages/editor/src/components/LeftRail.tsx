import {
  type LogoVariant,
  cloneArtboardForVariant,
} from "@openlogo/core";
import { documentStore, useDocument } from "../state/document";
import { type Tool, useEditorStore } from "../state/editor-store";

const tools: Array<{ id: Tool; label: string; shortcut: string }> = [
  { id: "select", label: "Select", shortcut: "V" },
  { id: "rectangle", label: "Rectangle", shortcut: "R" },
  { id: "ellipse", label: "Ellipse", shortcut: "O" },
  { id: "pen", label: "Pen", shortcut: "P" },
  { id: "path", label: "Mark", shortcut: "M" },
  { id: "text", label: "Text", shortcut: "T" },
];

const variantOptions: Array<{ id: LogoVariant; label: string }> = [
  { id: "icon", label: "Icon" },
  { id: "wordmark", label: "Wordmark" },
  { id: "horizontal", label: "Horizontal" },
  { id: "stacked", label: "Stacked" },
];

function formatPurpose(value: LogoVariant): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function LeftRail() {
  const document = useDocument();
  const tool = useEditorStore((state) => state.tool);
  const setTool = useEditorStore((state) => state.setTool);
  const setSelection = useEditorStore((state) => state.setSelection);

  function createVariant(purpose: LogoVariant) {
    const { artboard, nodes } = cloneArtboardForVariant(
      documentStore.document,
      documentStore.document.activeArtboardId,
      purpose,
    );
    documentStore.apply({ type: "add-artboard", artboard, nodes });
    setSelection([]);
  }

  return (
    <aside className="left-rail" aria-label="OpenLogo tools">
      <div className="brand-lockup">
        <span className="brand-mark">OL</span>
        <div>
          <strong>OpenLogo</strong>
          <small>Manual-first logo studio</small>
        </div>
      </div>

      <div className="tool-stack">
        {tools.map((item) => (
          <button
            className={tool === item.id ? "active" : ""}
            key={item.id}
            type="button"
            onClick={() => setTool(item.id)}
          >
            <span>{item.label}</span>
            <kbd>{item.shortcut}</kbd>
          </button>
        ))}
      </div>

      <section className="panel">
        <h2>Variants</h2>
        <div className="variant-grid">
          {variantOptions.map((variant) => (
            <button
              key={variant.id}
              type="button"
              onClick={() => createVariant(variant.id)}
            >
              + {variant.label}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Artboards</h2>
        <div className="layer-list">
          {document.artboards.map((item) => (
            <button
              key={item.id}
              className={
                item.id === document.activeArtboardId
                  ? "active layer-item"
                  : "layer-item"
              }
              type="button"
              onClick={() => {
                documentStore.apply({
                  type: "set-active-artboard",
                  artboardId: item.id,
                });
                setSelection([]);
              }}
            >
              <span>{item.name}</span>
              <small>{formatPurpose(item.purpose)}</small>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}
