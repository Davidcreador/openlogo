import { useEffect } from "react";
import { CanvasStage } from "./canvas/CanvasStage";
import { LeftRail } from "./components/LeftRail";
import { PreviewStrip } from "./components/PreviewStrip";
import { RightRail } from "./components/RightRail";
import { TopBar } from "./components/TopBar";
import { createAutosave, loadDocument } from "./lib/persistence";
import { documentStore } from "./state/document";
import { type Tool, useEditorStore } from "./state/editor-store";

const TOOL_SHORTCUTS: Record<string, Tool> = {
  v: "select",
  r: "rectangle",
  o: "ellipse",
  p: "path",
  t: "text",
};

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export default function App() {
  // Restore last session, then autosave on every committed change.
  useEffect(() => {
    let disposed = false;

    void loadDocument().then((stored) => {
      if (stored && !disposed) {
        documentStore.reset(stored);
      }
    });

    const autosave = createAutosave(() => documentStore.document);
    const unsubscribe = documentStore.subscribe(autosave);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  // Global keyboard shortcuts.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (isEditableTarget(event.target)) {
        return;
      }

      const state = useEditorStore.getState();
      const key = event.key.toLowerCase();

      if ((event.metaKey || event.ctrlKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          documentStore.redo();
        } else {
          documentStore.undo();
        }
        state.setSelection([]);
        return;
      }

      if (event.metaKey || event.ctrlKey) {
        return;
      }

      if (key === "delete" || key === "backspace") {
        if (state.selectedNodeIds.length > 0) {
          event.preventDefault();
          documentStore.apply({
            type: "delete-nodes",
            nodeIds: state.selectedNodeIds,
          });
          state.setSelection([]);
        }
        return;
      }

      if (key === "escape") {
        state.setSelection([]);
        return;
      }

      const tool = TOOL_SHORTCUTS[key];
      if (tool) {
        state.setTool(tool);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <main className="app-shell">
      <LeftRail />
      <section className="workspace" aria-label="Logo canvas workspace">
        <TopBar />
        <CanvasStage />
        <PreviewStrip />
      </section>
      <RightRail />
    </main>
  );
}
