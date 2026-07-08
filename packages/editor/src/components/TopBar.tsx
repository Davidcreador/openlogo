import { getActiveArtboard } from "@openlogo/core";
import {
  documentToSvg,
  downloadPngFromSvg,
  downloadTextFile,
} from "../lib/export";
import { documentStore, useDocument } from "../state/document";
import { useEditorStore } from "../state/editor-store";

export function TopBar() {
  const document = useDocument();
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const setSelection = useEditorStore((state) => state.setSelection);
  const artboard = getActiveArtboard(document);

  function deleteSelection() {
    if (selectedNodeIds.length === 0) {
      return;
    }
    documentStore.apply({ type: "delete-nodes", nodeIds: selectedNodeIds });
    setSelection([]);
  }

  function exportSvg() {
    const svg = documentToSvg(document);
    downloadTextFile(
      svg,
      `${artboard.name.toLowerCase().replaceAll(" ", "-")}.svg`,
      "image/svg+xml",
    );
  }

  async function exportPng() {
    const svg = documentToSvg(document);
    await downloadPngFromSvg(
      svg,
      `${artboard.name.toLowerCase().replaceAll(" ", "-")}@2x.png`,
      artboard.width,
      artboard.height,
    );
  }

  return (
    <header className="top-bar">
      <div>
        <strong>{artboard.name}</strong>
        <span>
          {artboard.width} × {artboard.height}
        </span>
      </div>
      <div className="top-actions">
        <button
          type="button"
          onClick={() => {
            documentStore.undo();
            setSelection([]);
          }}
          disabled={!documentStore.canUndo}
        >
          Undo
        </button>
        <button
          type="button"
          onClick={() => {
            documentStore.redo();
            setSelection([]);
          }}
          disabled={!documentStore.canRedo}
        >
          Redo
        </button>
        <button
          type="button"
          onClick={deleteSelection}
          disabled={selectedNodeIds.length === 0}
        >
          Delete
        </button>
        <button type="button" onClick={exportSvg}>
          Export SVG
        </button>
        <button type="button" onClick={() => void exportPng()}>
          Export PNG
        </button>
      </div>
    </header>
  );
}
