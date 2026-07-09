import { useEffect } from "react";
import { CanvasStage } from "./canvas/CanvasStage";
import { Inspector } from "./components/Inspector";
import { PreviewStrip } from "./components/PreviewStrip";
import { Toolbar } from "./components/Toolbar";
import { TopBar } from "./components/TopBar";
import { ZoomControls } from "./components/ZoomControls";
import {
  collectLeafNodeIds,
  findContainerId,
  getActiveArtboard,
  getContainerChildIds,
  getParentGroupId,
} from "@openlogo/core";
import { fitBounds, zoomAt } from "@openlogo/renderer";
import {
  copyNodes,
  cutNodes,
  duplicateNodes,
  pasteNodes,
} from "./lib/clipboard";
import {
  deleteSelection,
  groupSelection,
  ungroupSelection,
} from "./lib/group-ops";
import { createAutosave, loadDocument } from "./lib/persistence";
import { ensureDocumentFonts } from "./lib/text-to-path";
import { documentStore } from "./state/document";
import { type Tool, useEditorStore } from "./state/editor-store";

const TOOL_SHORTCUTS: Record<string, Tool> = {
  v: "select",
  r: "rectangle",
  o: "ellipse",
  p: "pen",
  m: "path",
  t: "text",
  i: "eyedropper",
  // Needs 2+ shapes selected; CanvasStage bounces back to select if not.
  s: "shapeBuilder",
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
      ensureDocumentFonts();
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
        if (state.tool === "shapeBuilder") {
          state.setTool("select"); // regions would go stale — cancel first
        }
        if (event.shiftKey) {
          documentStore.redo();
        } else {
          documentStore.undo();
        }
        state.setSelection([]);
        state.setActiveGroupId(null); // scope target may no longer exist
        return;
      }

      if (event.metaKey || event.ctrlKey) {
        const selection = state.selectedNodeIds;

        if (key === "c" && selection.length > 0) {
          event.preventDefault();
          copyNodes(selection);
          return;
        }

        if (key === "x" && selection.length > 0) {
          event.preventDefault();
          cutNodes(selection);
          state.setSelection([]);
          return;
        }

        if (key === "v") {
          event.preventDefault();
          const pasted = pasteNodes();
          if (pasted.length > 0) {
            state.setSelection(pasted);
            state.setTool("select");
          }
          return;
        }

        if (key === "d") {
          // Always consumed — otherwise an empty selection lets the
          // browser open its bookmark dialog.
          event.preventDefault();
          if (selection.length > 0) {
            const cloned = duplicateNodes(selection);
            if (cloned.length > 0) {
              state.setSelection(cloned);
            }
          }
          return;
        }

        if (key === "a") {
          event.preventDefault();
          const document = documentStore.document;
          const artboard = document.artboards.find(
            (item) => item.id === document.activeArtboardId,
          );
          if (artboard) {
            state.setSelection(
              artboard.nodeIds.filter((id) => {
                const node = document.nodes[id];
                return node && node.visible && !node.locked;
              }),
            );
            state.setTool("select");
          }
          return;
        }

        // Zoom: ⌘0 fit, ⌘1 100%, ⌘+/⌘−.
        if (key === "0" || key === "1" || key === "=" || key === "+" || key === "-") {
          event.preventDefault();
          const { camera, viewport, setCamera } = state;
          if (viewport.width === 0) {
            return;
          }
          if (key === "0") {
            setCamera(
              fitBounds(
                getActiveArtboard(documentStore.document),
                viewport.width,
                viewport.height,
              ),
            );
          } else {
            const center = { x: viewport.width / 2, y: viewport.height / 2 };
            const zoom =
              key === "1"
                ? 1
                : key === "-"
                  ? camera.zoom / 1.25
                  : camera.zoom * 1.25;
            setCamera(zoomAt(camera, center, zoom));
          }
          return;
        }

        // ⌘G group, ⇧⌘G ungroup — real scene-graph groups.
        if (key === "g") {
          event.preventDefault();
          if (selection.length === 0) {
            return;
          }
          if (event.shiftKey) {
            const freed = ungroupSelection(selection);
            if (freed.length > 0) {
              state.setSelection(freed);
            }
          } else {
            const groupId = groupSelection(selection);
            if (groupId) {
              state.setSelection([groupId]);
            }
          }
          return;
        }

        // ⌘] forward, ⌘[ backward within the node's container.
        if ((key === "]" || key === "[") && selection.length === 1) {
          event.preventDefault();
          const document = documentStore.document;
          const nodeId = selection[0]!;
          const containerId = findContainerId(document, nodeId);
          if (!containerId) {
            return;
          }
          const list = getContainerChildIds(document, containerId);
          const index = list.indexOf(nodeId);
          const toIndex =
            key === "]"
              ? Math.min(list.length - 1, index + 1)
              : Math.max(0, index - 1);
          if (index !== -1 && toIndex !== index) {
            documentStore.apply({
              type: "reorder-node",
              containerId,
              nodeId,
              toIndex,
            });
          }
          return;
        }

        return;
      }

      if (key === "delete" || key === "backspace") {
        if (state.editingPathId) {
          return; // Bezier edit mode owns these keys.
        }
        if (state.selectedNodeIds.length > 0) {
          event.preventDefault();
          deleteSelection(state.selectedNodeIds);
          state.setSelection([]);
        }
        return;
      }

      if (key === "escape") {
        // Shape Builder owns Escape (CanvasStage cancels the session).
        if (state.tool === "shapeBuilder") {
          return;
        }
        // Step out of the active group scope one level, selecting it.
        if (state.activeGroupId) {
          const parent = getParentGroupId(
            documentStore.document,
            state.activeGroupId,
          );
          state.setSelection([state.activeGroupId]);
          state.setActiveGroupId(parent);
          return;
        }
        state.setSelection([]);
        return;
      }

      // Arrow-key nudge: 1px, 10px with Shift. Groups nudge their leaves.
      if (key.startsWith("arrow") && state.selectedNodeIds.length > 0) {
        if (state.editingPathId) {
          return;
        }
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = key === "arrowleft" ? -step : key === "arrowright" ? step : 0;
        const dy = key === "arrowup" ? -step : key === "arrowdown" ? step : 0;
        documentStore.apply({
          type: "update-nodes",
          updates: collectLeafNodeIds(
            documentStore.document,
            state.selectedNodeIds,
          )
            .map((nodeId) => {
              const node = documentStore.document.nodes[nodeId];
              return node && !node.locked
                ? { nodeId, patch: { x: node.x + dx, y: node.y + dy } }
                : null;
            })
            .filter(
              (update): update is NonNullable<typeof update> => update !== null,
            ),
        });
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
    <main className="app-shell grid h-screen grid-rows-[52px_1fr]">
      <TopBar />
      {/* The whole workspace shares one textured surface; the GPU canvas
          clears to transparent so panels genuinely sit on the same material. */}
      <div className="app-main grid min-h-0 grid-cols-[72px_minmax(0,1fr)_304px] bg-surface bg-[radial-gradient(var(--color-canvas-dot)_1px,transparent_1.15px)] bg-[size:20px_20px]">
        <Toolbar />
        <section
          className="canvas-area relative min-h-0 min-w-0"
          aria-label="Logo canvas workspace"
        >
          <CanvasStage />
          <ZoomControls />
          <PreviewStrip />
        </section>
        <Inspector />
      </div>
    </main>
  );
}
