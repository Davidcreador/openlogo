import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Effect } from "effect";
import { CanvasStage } from "./canvas/CanvasStage";
import {
  CanvasContextMenu,
  type CanvasMenuState,
} from "./components/CanvasContextMenu";
import { CommandPalette } from "./components/CommandPalette";
import { PreviewStrip } from "./components/PreviewStrip";
import { ShortcutOverlay } from "./components/ShortcutOverlay";
import { Toast } from "./components/Toast";
import { Toolbar } from "./components/Toolbar";
import { TopBar } from "./components/TopBar";
import { ArtboardEdgeControls } from "./components/ArtboardEdgeControls";
import { ZoomControls } from "./components/ZoomControls";
import {
  type AlignEdge,
  collectLeafNodeIds,
  createInitialDocument,
  getActiveArtboard,
  getParentGroupId,
  pixelSnapPatch,
} from "@openlogo/core";
import { type BooleanOp, fitBounds, zoomAt } from "@openlogo/renderer";
import { fitArtboardAfterViewportChange } from "./lib/artboard-ops";
import { canPasteNodes, copyNodes, cutNodes, pasteNodes } from "./lib/clipboard";
import { applyBooleanOp, combinableNodes } from "./lib/boolean-ops";
import { getCanvasKit } from "./lib/canvaskit";
import { cancelActiveCanvasSessions } from "./lib/canvas-sessions";
import {
  clippingMaskFailureMessage,
  makeClippingMask,
  releaseClippingMask,
} from "./lib/clipping-mask";
import { makeCompoundPath, releaseCompoundPath } from "./lib/compound-path";
import {
  OPENLOGO_EXTENSION,
  copyAsSvg,
  openDocumentFileWithToast,
  promptOpenDocument,
  saveDocumentFile,
} from "./lib/document-file";
import { joinSelectedPaths } from "./lib/path-surgery";
import { shouldBlockWorkspaceShortcuts } from "./lib/keyboard-shortcuts";
import {
  type CommandAvailability,
  type CommandId,
} from "./lib/commands-registry";
import { recordTransform, transformAgain } from "./lib/transform-again";
import {
  deleteSelection,
  groupSelection,
  ungroupSelection,
} from "./lib/group-ops";
import {
  alignNodes,
  arrangeNodes,
  flipNodes,
  type ArrangePlacement,
} from "./lib/object-ops";
import {
  clearEditingSession,
  editingSessionDocumentId,
  markEditingSession,
} from "./lib/session-resume";
import { fontCatalog } from "./lib/font-catalog";
import { DocumentSession } from "./lib/document-session";
import { documentLibrary } from "./lib/document-library";
import { markDocumentReady } from "./lib/performance";
import { importSvg } from "./lib/svg-import";
import { ensureDocumentFonts } from "./lib/text-to-path";
import { documentStore } from "./state/document";
import { type Tool, useEditorStore } from "./state/editor-store";

// Large modal workflows are absent from the first paint. Loading them on
// demand keeps document/renderer startup inside the initial-JS budget while
// preserving their state in the same editor store.
const DocumentLibraryDialog = lazy(() =>
  import("./components/DocumentLibraryDialog").then((module) => ({
    default: module.DocumentLibraryDialog,
  })),
);
const ExportDialog = lazy(() =>
  import("./components/ExportDialog").then((module) => ({
    default: module.ExportDialog,
  })),
);
const TransformDialog = lazy(() =>
  import("./components/TransformDialog").then((module) => ({
    default: module.TransformDialog,
  })),
);
const DesignMateCompanion = lazy(() =>
  import("./components/DesignMateCompanion").then((module) => ({
    default: module.DesignMateCompanion,
  })),
);
const DesignMateDock = lazy(() =>
  import("./components/DesignMateCompanion").then((module) => ({
    default: module.DesignMateDock,
  })),
);
const DashboardView = lazy(() =>
  import("./components/DashboardView").then((module) => ({
    default: module.DashboardView,
  })),
);
const Inspector = lazy(() =>
  import("./components/Inspector").then((module) => ({
    default: module.Inspector,
  })),
);
const EditorTemplatePanel = lazy(
  () => import("./components/EditorTemplatePanel"),
);

const TOOL_SHORTCUTS: Record<string, Tool> = {
  v: "select",
  r: "rectangle",
  o: "ellipse",
  p: "pen",
  m: "path",
  t: "text",
  i: "eyedropper",
  g: "gradient",
  // Needs 2+ shapes selected; CanvasStage bounces back to select if not.
  s: "shapeBuilder",
};

const COMMAND_TO_TOOL: Partial<Record<CommandId, Tool>> = {
  "tool.select": "select",
  "tool.rectangle": "rectangle",
  "tool.ellipse": "ellipse",
  "tool.pen": "pen",
  "tool.path": "path",
  "tool.text": "text",
  "tool.eyedropper": "eyedropper",
  "tool.gradient": "gradient",
  "tool.shape-builder": "shapeBuilder",
};

const ALIGN_COMMANDS: Partial<Record<CommandId, AlignEdge>> = {
  "arrange.align-left": "left",
  "arrange.align-center": "centerX",
  "arrange.align-right": "right",
  "arrange.align-top": "top",
  "arrange.align-middle": "centerY",
  "arrange.align-bottom": "bottom",
};

const BOOLEAN_COMMANDS: Partial<Record<CommandId, BooleanOp>> = {
  "edit.boolean-union": "union",
  "edit.boolean-subtract": "subtract",
  "edit.boolean-intersect": "intersect",
  "edit.boolean-exclude": "exclude",
};

const ARRANGE_COMMANDS: Partial<Record<CommandId, ArrangePlacement>> = {
  "arrange.forward": "forward",
  "arrange.backward": "backward",
  "arrange.front": "front",
  "arrange.back": "back",
};

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function selectAllNodes(): void {
  const state = useEditorStore.getState();
  const document = documentStore.document;
  const artboard = document.artboards.find(
    (item) => item.id === document.activeArtboardId,
  );
  if (!artboard) return;
  state.setSelection(
    artboard.nodeIds.filter((id) => {
      const node = document.nodes[id];
      return node && node.visible && !node.locked;
    }),
  );
  state.setTool("select");
}

function setZoom(zoom: "fit" | 1): void {
  const state = useEditorStore.getState();
  const { camera, viewport } = state;
  if (viewport.width === 0 || viewport.height === 0) return;
  if (zoom === "fit") {
    state.setCamera(
      fitBounds(
        getActiveArtboard(documentStore.document),
        viewport.width,
        viewport.height,
      ),
    );
    return;
  }
  state.setCamera(
    zoomAt(camera, { x: viewport.width / 2, y: viewport.height / 2 }, zoom),
  );
}

async function runBooleanCommand(
  op: BooleanOp,
  selection: string[],
): Promise<void> {
  const state = useEditorStore.getState();
  try {
    const id = await applyBooleanOp(op, selection);
    if (id) state.setSelection([id]);
    else state.setToast("Those shapes could not be combined.");
  } catch (error) {
    console.warn("Boolean operation failed", error);
    state.setToast(
      "Boolean operation failed. The original shapes were preserved.",
    );
  }
}

function runEditorCommand(id: CommandId): void {
  const state = useEditorStore.getState();
  const selection = state.selectedNodeIds;
  const tool = COMMAND_TO_TOOL[id];
  if (tool) {
    if (tool === "gradient") state.setGradientTarget("fill");
    state.setTool(tool);
    return;
  }

  const booleanOp = BOOLEAN_COMMANDS[id];
  if (booleanOp) {
    void runBooleanCommand(booleanOp, selection);
    return;
  }

  const alignEdge = ALIGN_COMMANDS[id];
  if (alignEdge) {
    alignNodes(selection, alignEdge, state.keyObjectId);
    return;
  }

  const arrangement = ARRANGE_COMMANDS[id];
  if (arrangement) {
    arrangeNodes(selection, arrangement);
    return;
  }

  switch (id) {
    case "edit.undo":
    case "edit.redo":
      cancelActiveCanvasSessions();
      if (id === "edit.undo") documentStore.undo();
      else documentStore.redo();
      state.setSelection([]);
      state.setActiveGroupId(null);
      return;
    case "edit.cut":
      cutNodes(selection);
      state.setSelection([]);
      return;
    case "edit.copy":
      copyNodes(selection);
      return;
    case "edit.paste": {
      const ids = pasteNodes();
      if (ids.length > 0) {
        state.setSelection(ids);
        state.setTool("select");
      }
      return;
    }
    case "edit.duplicate":
      copyNodes(selection);
      runEditorCommand("edit.paste");
      return;
    case "edit.transform-again": {
      const ids = transformAgain(selection);
      if (ids && ids.length > 0) state.setSelection(ids);
      return;
    }
    case "edit.select-all":
      selectAllNodes();
      return;
    case "edit.delete":
      deleteSelection(selection);
      state.setSelection([]);
      return;
    case "edit.group": {
      const groupId = groupSelection(selection);
      if (groupId) state.setSelection([groupId]);
      return;
    }
    case "edit.ungroup": {
      const ids = ungroupSelection(selection);
      if (ids.length > 0) state.setSelection(ids);
      return;
    }
    case "arrange.flip-horizontal":
      flipNodes(selection, "horizontal");
      return;
    case "arrange.flip-vertical":
      flipNodes(selection, "vertical");
      return;
    case "arrange.transform":
      state.setTransformDialogOpen(true);
      return;
    case "view.fit":
      setZoom("fit");
      return;
    case "view.actual-size":
      setZoom(1);
      return;
    case "view.toggle-grid":
      state.setShowGrid(!state.showGrid);
      return;
    case "view.design-mate":
      document
        .querySelector<HTMLButtonElement>("[data-design-mate-trigger]")
        ?.click();
      return;
    case "document.open":
      promptOpenDocument();
      return;
    case "document.save":
      saveDocumentFile();
      return;
    case "document.library":
      state.setDocumentLibraryOpen(true);
      return;
    case "document.export":
      state.setExportDialogOpen(true);
  }
}

function commandAvailability(selection: string[]): CommandAvailability {
  const state = useEditorStore.getState();
  return {
    selectionCount: selection.length,
    selectedGroupCount: selection.filter(
      (id) => documentStore.document.nodes[id]?.type === "group",
    ).length,
    canUndo: documentStore.canUndo,
    canRedo: documentStore.canRedo,
    canPaste: canPasteNodes(),
    canBoolean: combinableNodes(selection).length >= 2,
    viewportReady: state.viewport.width > 0 && state.viewport.height > 0,
  };
}

export default function App() {
  const view = useEditorStore((state) => state.view);
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const designMateOpen = useEditorStore((state) => state.designMateOpen);
  const [sessionReady, setSessionReady] = useState(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutOverlayOpen, setShortcutOverlayOpen] = useState(false);
  const [canvasMenu, setCanvasMenu] = useState<CanvasMenuState | null>(null);
  const pendingSvgRef = useRef<File | null>(null);
  const transformDialogOpen = useEditorStore(
    (state) => state.transformDialogOpen,
  );
  const exportDialogOpen = useEditorStore((state) => state.exportDialogOpen);
  const documentLibraryOpen = useEditorStore(
    (state) => state.documentLibraryOpen,
  );
  const templatePanelOpen = useEditorStore(
    (state) => state.templatePanelOpen,
  );
  const [loadedDialogs, setLoadedDialogs] = useState({
    transform: false,
    export: false,
    library: false,
  });
  // Skip the mount tick — only re-fit when the dock actually toggles.
  const designMateFitReady = useRef(false);

  useEffect(() => {
    if (
      (transformDialogOpen && !loadedDialogs.transform) ||
      (exportDialogOpen && !loadedDialogs.export) ||
      (documentLibraryOpen && !loadedDialogs.library)
    ) {
      setLoadedDialogs((current) => ({
        transform: current.transform || transformDialogOpen,
        export: current.export || exportDialogOpen,
        library: current.library || documentLibraryOpen,
      }));
    }
  }, [
    documentLibraryOpen,
    exportDialogOpen,
    loadedDialogs,
    transformDialogOpen,
  ]);

  // Dock open/close changes the canvas column width; wait for ResizeObserver
  // to publish the new viewport, then fit so the artboard is not clipped.
  useEffect(() => {
    if (!designMateFitReady.current) {
      designMateFitReady.current = true;
      return;
    }
    fitArtboardAfterViewportChange();
  }, [designMateOpen]);

  // Dashboard boot reads repository metadata only. CanvasKit, the active head,
  // fonts, and DocumentSession remain cold until the user enters the editor.
  useEffect(() => {
    let disposed = false;
    setBootstrapLoading(true);
    void documentLibrary
      .bootstrapLibrary()
      .then(async () => {
        if (disposed) {
          return;
        }
        // A reload while editing resumes that document instead of the
        // dashboard. Tab-scoped: fresh visits keep the dashboard-first
        // cold boot.
        const resumeId = editingSessionDocumentId();
        if (
          resumeId &&
          useEditorStore.getState().view === "dashboard" &&
          documentLibrary.snapshot.documents.some(
            (summary) => summary.documentId === resumeId,
          )
        ) {
          try {
            const document = await documentLibrary.openDocument(resumeId);
            if (!disposed) {
              setBootstrapLoading(false);
              enterDocument(document);
              return;
            }
          } catch (error) {
            console.warn("Could not resume the editing session", error);
            clearEditingSession();
          }
        } else if (resumeId) {
          clearEditingSession();
        }
        if (disposed) {
          return;
        }
        setBootstrapLoading(false);
        const migrationNotice = documentLibrary.snapshot.notice;
        if (migrationNotice) {
          useEditorStore.getState().setToast(migrationNotice);
        }
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }
        console.error("Document library bootstrap failed", error);
        setBootstrapLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [bootstrapAttempt]);

  // Once a project is chosen, compile CanvasKit and start ordered persistence
  // together. CanvasStage consumes the cached CanvasKit promise and owns its
  // user-facing failure recovery, preserving the established startup budget.
  useEffect(() => {
    if (view !== "editor") {
      setSessionReady(false);
      return;
    }
    let disposed = false;
    void getCanvasKit().catch(() => undefined);
    const session = new DocumentSession({
      store: documentStore,
      // Dashboard open/create already proved the repository head readable and
      // prepared its revision. Session restoration adopts that selected copy.
      load: async () => documentStore.document,
      save: (document) => documentLibrary.saveDocument(document),
      getVisibilityState: () => window.document.visibilityState,
      onStateChange: (state) =>
        useEditorStore.getState().setDocumentSessionState(state),
      onFailure: ({ phase, error }) => {
        console.warn(`Document ${phase} failed`, error);
        const libraryMessage = documentLibrary.snapshot.error;
        useEditorStore
          .getState()
          .setToast(
            libraryMessage ??
              (phase === "load"
                ? "Local recovery is unavailable. Autosave is paused to protect stored work; use ⌘S to save a copy."
                : "Local save failed. Your document is still open; the next edit will retry."),
          );
      },
    });
    documentLibrary.attachSession(session);

    void session
      .start()
      .then(() => {
        if (disposed) {
          return;
        }
        setSessionReady(true);
        markDocumentReady();
        ensureDocumentFonts();
        const migrationNotice = documentLibrary.snapshot.notice;
        if (migrationNotice) {
          useEditorStore.getState().setToast(migrationNotice);
        }
        const pendingSvg = pendingSvgRef.current;
        pendingSvgRef.current = null;
        if (pendingSvg) {
          void pendingSvg
            .text()
            .then((text) => Effect.runPromise(importSvg(text)))
            .then((ids) => {
              if (disposed) {
                return;
              }
              if (ids.length > 0) {
                useEditorStore.getState().setSelection(ids);
                useEditorStore
                  .getState()
                  .setToast(
                    ids.warnings.length > 0
                      ? `Imported “${pendingSvg.name}” with warnings: ${ids.warnings.join(" ")}`
                      : `Imported “${pendingSvg.name}”.`,
                  );
              } else if (ids.warnings.length > 0) {
                useEditorStore.getState().setToast(ids.warnings.join(" "));
              } else {
                useEditorStore
                  .getState()
                  .setToast("This SVG contains no supported editable shapes.");
              }
            })
            .catch((error: unknown) => {
              if (!disposed) {
                console.warn("SVG import failed", error);
                useEditorStore
                  .getState()
                  .setToast("SVG import failed. The new project was preserved.");
              }
            });
        }
        // Documents can reference catalog-only families; once the full
        // index is in, resolve any that the built-in list couldn't.
        void Effect.runPromise(fontCatalog.init()).then(() => {
          if (!disposed) {
            ensureDocumentFonts();
          }
        });
      })
      .catch((error: unknown) => {
        if (disposed) {
          return;
        }
        console.error("Document session failed to start", error);
        useEditorStore.getState().setDocumentSessionState("error");
        useEditorStore
          .getState()
          .setToast(
            "OpenLogo could not restore local work. Autosave is paused; use ⌘S to save a copy.",
          );
        setSessionReady(true);
        markDocumentReady();
      });

    return () => {
      disposed = true;
      documentLibrary.detachSession(session);
      session.dispose();
    };
  }, [view]);

  // Commands and document switches can remove nodes without going through a
  // selection-specific UI path. Keep every editor reference inside the
  // committed scene so renderer and inspector queries never chase stale ids.
  useEffect(
    () =>
      documentStore.subscribe((document, kind) => {
        if (kind !== "committed") {
          return;
        }
        const state = useEditorStore.getState();
        const selection = state.selectedNodeIds.filter(
          (id) => document.nodes[id] !== undefined,
        );
        if (selection.length !== state.selectedNodeIds.length) {
          state.setSelection(selection);
        }
        if (
          state.activeGroupId &&
          document.nodes[state.activeGroupId]?.type !== "group"
        ) {
          state.setActiveGroupId(null);
        }
        if (
          state.editingPathId &&
          document.nodes[state.editingPathId]?.type !== "path"
        ) {
          state.setEditingPathId(null);
        }
      }),
    [],
  );

  // Global keyboard shortcuts.
  useEffect(() => {
    if (!sessionReady || view !== "editor") {
      return;
    }

    function onKeyDown(event: KeyboardEvent) {
      const state = useEditorStore.getState();
      const key = event.key.toLowerCase();
      const modifier = event.metaKey || event.ctrlKey;
      if (
        document.querySelector('[role="dialog"][aria-modal="true"]') ||
        shouldBlockWorkspaceShortcuts(
          {
            ...state,
            commandPaletteOpen,
            shortcutOverlayOpen,
            contextMenuOpen: canvasMenu !== null,
          },
          Boolean(documentLibrary.snapshot.operation),
        )
      ) {
        return;
      }

      if (modifier && key === "k") {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (modifier && key === "/") {
        event.preventDefault();
        setShortcutOverlayOpen(true);
        return;
      }
      if (isEditableTarget(event.target)) return;

      if (modifier && key === "z") {
        event.preventDefault();
        runEditorCommand(event.shiftKey ? "edit.redo" : "edit.undo");
        return;
      }

      if (modifier) {
        const selection = state.selectedNodeIds;

        // ⇧⌘C = OS clipboard "Copy as SVG" (selection, else active board).
        // Checked before plain ⌘C, which stays the internal node copy.
        if (key === "c" && event.shiftKey) {
          event.preventDefault();
          void copyAsSvg();
          return;
        }

        if (key === "c" && selection.length > 0) {
          event.preventDefault();
          runEditorCommand("edit.copy");
          return;
        }

        // ⌘S = save as .openlogo, ⌘O = open one (browser defaults eaten).
        if (key === "s") {
          event.preventDefault();
          runEditorCommand("document.save");
          return;
        }
        if (key === "o") {
          event.preventDefault();
          runEditorCommand("document.open");
          return;
        }

        if (key === "x" && selection.length > 0) {
          event.preventDefault();
          runEditorCommand("edit.cut");
          return;
        }

        if (key === "v") {
          event.preventDefault();
          runEditorCommand("edit.paste");
          return;
        }

        // ⌘D = Transform Again (Illustrator): repeat the last committed
        // move/rotate/scale/reflect, honouring its copy flag. Duplicate
        // moved to ⌥-drag and ⌘C⌘V.
        if (key === "d") {
          // Always consumed — otherwise an empty selection lets the
          // browser open its bookmark dialog.
          event.preventDefault();
          if (selection.length > 0) {
            runEditorCommand("edit.transform-again");
          }
          return;
        }

        // ⌥⌘7 / Alt+Ctrl+7 = Release Clipping Mask. The mask and every
        // content node return as siblings in one undoable operation.
        if (event.code === "Digit7" && event.altKey && !event.shiftKey) {
          event.preventDefault();
          if (!state.editingPathId && selection.length === 1) {
            const ids = releaseClippingMask(selection);
            if (ids) {
              state.setSelection(ids);
            } else {
              state.setToast("Select one unlocked clipping group to release.");
            }
          }
          return;
        }

        // ⌘7 = Make Clipping Mask (Illustrator). The topmost selected
        // vector shape becomes the path; sources stay editable and intact.
        if (
          event.code === "Digit7" &&
          !event.altKey &&
          !event.shiftKey
        ) {
          event.preventDefault();
          if (!state.editingPathId) {
            const groupId = makeClippingMask(selection);
            if (groupId) {
              state.setSelection([groupId]);
            } else {
              state.setToast(clippingMaskFailureMessage(selection));
            }
          }
          return;
        }

        // ⌥⇧⌘8 / Alt+Shift+Ctrl+8 = Release Compound Path (Illustrator).
        // All contours are prepared before the source node is replaced.
        if (
          event.code === "Digit8" &&
          event.shiftKey &&
          event.altKey
        ) {
          event.preventDefault();
          if (!state.editingPathId && selection.length === 1) {
            try {
              const ids = releaseCompoundPath(selection);
              if (ids) {
                state.setSelection(ids);
              } else {
                state.setToast("Select one editable compound path.");
              }
            } catch (error: unknown) {
              console.warn("Release compound path failed", error);
              state.setToast(
                "Release compound path failed. The original path was preserved.",
              );
            }
          }
          return;
        }

        // ⌘8 = Make Compound Path (Illustrator). Conversion is atomic: an
        // unsupported operand or engine failure leaves every source intact.
        if (
          event.code === "Digit8" &&
          !event.shiftKey &&
          !event.altKey
        ) {
          event.preventDefault();
          if (!state.editingPathId && selection.length >= 2) {
            void makeCompoundPath(selection)
              .then((id) => {
                if (id) {
                  useEditorStore.getState().setSelection([id]);
                } else {
                  useEditorStore
                    .getState()
                    .setToast("Select two or more sibling vector shapes.");
                }
              })
              .catch((error: unknown) => {
                console.warn("Compound path failed", error);
                useEditorStore
                  .getState()
                  .setToast(
                    "Compound path failed. The original shapes were preserved.",
                  );
              });
          }
          return;
        }

        // ⌘J = Join paths (edit-mode joins are handled by CanvasStage,
        // which consumes the event first). event.code: ⌥J types "∆".
        if (event.code === "KeyJ" && !event.altKey) {
          event.preventDefault();
          if (!state.editingPathId && selection.length > 0) {
            const ids = joinSelectedPaths(selection);
            if (ids) {
              state.setSelection(ids);
            }
          }
          return;
        }

        if (key === "a") {
          event.preventDefault();
          runEditorCommand("edit.select-all");
          return;
        }

        // Zoom: ⌘0 fit, ⌘1 100%, ⌘+/⌘−. Grid: ⌘' (Illustrator Show Grid).
        if (
          key === "0" ||
          key === "1" ||
          key === "=" ||
          key === "+" ||
          key === "-" ||
          key === "'" ||
          key === '"'
        ) {
          event.preventDefault();
          if (key === "'" || key === '"') {
            runEditorCommand("view.toggle-grid");
            return;
          }
          const { camera, viewport, setCamera } = state;
          if (viewport.width === 0) {
            return;
          }
          if (key === "0") {
            runEditorCommand("view.fit");
          } else if (key === "1") {
            runEditorCommand("view.actual-size");
          } else {
            const center = { x: viewport.width / 2, y: viewport.height / 2 };
            const zoom = key === "-" ? camera.zoom / 1.25 : camera.zoom * 1.25;
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
          runEditorCommand(event.shiftKey ? "edit.ungroup" : "edit.group");
          return;
        }

        // ⌘] forward, ⌘[ backward within each node's container.
        if ((key === "]" || key === "[") && selection.length > 0) {
          event.preventDefault();
          runEditorCommand(
            key === "]" ? "arrange.forward" : "arrange.backward",
          );
          return;
        }

        return;
      }

      // ] to front, [ to back (Figma convention; ⌘ variants step one slot).
      if ((key === "]" || key === "[") && !state.editingPathId) {
        if (state.selectedNodeIds.length > 0) {
          event.preventDefault();
          runEditorCommand(key === "]" ? "arrange.front" : "arrange.back");
        }
        return;
      }

      if (key === "delete" || key === "backspace") {
        if (state.editingPathId) {
          return; // Bezier edit mode owns these keys.
        }
        if (state.selectedNodeIds.length > 0) {
          event.preventDefault();
          runEditorCommand("edit.delete");
          return;
        }
        // Nothing selected: delete the active artboard (never the last
        // one). Undoable, and the toast says so.
        const doc = documentStore.document;
        if (doc.artboards.length > 1) {
          event.preventDefault();
          const target = doc.artboards.find(
            (item) => item.id === doc.activeArtboardId,
          );
          if (target) {
            documentStore.apply({
              type: "remove-artboard",
              artboardId: target.id,
            });
            state.setToast(`Deleted “${target.name}” — ⌘Z to undo.`);
          }
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
        const snap = state.pixelSnap
          ? pixelSnapPatch
          : (patch: { x: number; y: number }) => patch;
        documentStore.apply({
          type: "update-nodes",
          updates: collectLeafNodeIds(
            documentStore.document,
            state.selectedNodeIds,
          )
            .map((nodeId) => {
              const node = documentStore.document.nodes[nodeId];
              return node && !node.locked
                ? { nodeId, patch: snap({ x: node.x + dx, y: node.y + dy }) }
                : null;
            })
            .filter(
              (update): update is NonNullable<typeof update> => update !== null,
            ),
        });
        // Nudges are moves: ⌘D repeats the last one, Illustrator-style.
        recordTransform({ kind: "move", dx, dy, copy: false });
        return;
      }

      const tool = TOOL_SHORTCUTS[key];
      if (tool) {
        state.setTool(tool);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canvasMenu, commandPaletteOpen, sessionReady, shortcutOverlayOpen, view]);

  function enterDocument(
    document: Parameters<typeof documentStore.reset>[0],
    openHistory = false,
  ) {
    documentStore.cancelPreview();
    documentStore.reset(document);
    const editor = useEditorStore.getState();
    editor.setSelection([]);
    editor.setActiveGroupId(null);
    editor.setEditingPathId(null);
    editor.setTool("select");
    editor.setRendererReady(false);
    editor.setDocumentSessionState("loading");
    editor.setDocumentLibraryOpen(openHistory);
    editor.setTemplatePanelOpen(false);
    setSessionReady(false);
    markEditingSession(documentStore.document.id);
    editor.setView("editor");
  }

  async function importSvgProject(file: File): Promise<void> {
    const document = createInitialDocument();
    const artboard = document.artboards[0]!;
    document.name = file.name.replace(/\.svg$/i, "").trim() || "Imported SVG";
    document.nodes = {};
    artboard.nodeIds = [];
    artboard.name = "Imported SVG";
    const created = await documentLibrary.createDocument(document);
    pendingSvgRef.current = file;
    enterDocument(created);
  }

  if (view === "dashboard") {
    if (bootstrapLoading) {
      return (
        <main
          className="grid h-screen place-items-center bg-chrome text-chrome-text"
          aria-busy="true"
          aria-label="Loading OpenLogo projects"
        >
          <div className="flex items-center gap-12 rounded-panel border border-chrome-hairline bg-[rgb(255_255_255/0.035)] px-18 py-14 shadow-[0_12px_40px_rgb(8_6_12/0.35)]">
            <span className="grid h-36 w-36 place-items-center rounded-[10px] bg-[linear-gradient(135deg,#6a82f8,var(--color-accent)_55%,var(--color-accent-deep))] text-[13px] font-extrabold tracking-[-0.05em] text-white">
              OL
            </span>
            <span>
              <strong className="block text-[14px]">OpenLogo</strong>
              <span className="mt-2 block text-[12px] text-chrome-dim">
                Loading projects…
              </span>
            </span>
          </div>
        </main>
      );
    }
    return (
      <Suspense
        fallback={
          <main
            className="grid h-screen place-items-center bg-chrome text-chrome-dim"
            aria-busy="true"
            aria-label="Loading project dashboard"
          >
            <span className="text-[12px]">Loading dashboard…</span>
          </main>
        }
      >
        <DashboardView
          onEnterDocument={enterDocument}
          onImportSvg={importSvgProject}
          onRetryBootstrap={() =>
            setBootstrapAttempt((attempt) => attempt + 1)
          }
        />
        <Toast />
      </Suspense>
    );
  }

  if (!sessionReady) {
    return (
      <main
        className="grid h-screen place-items-center bg-chrome text-chrome-text"
        aria-busy="true"
        aria-label="Restoring OpenLogo workspace"
      >
        <div className="flex items-center gap-12 rounded-panel border border-chrome-hairline bg-[rgb(255_255_255/0.035)] px-18 py-14 shadow-[0_12px_40px_rgb(8_6_12/0.35)]">
          <span className="grid h-36 w-36 place-items-center rounded-[10px] bg-[linear-gradient(135deg,#6a82f8,var(--color-accent)_55%,var(--color-accent-deep))] text-[13px] font-extrabold tracking-[-0.05em] text-white">
            OL
          </span>
          <span>
            <strong className="block text-[14px]">OpenLogo</strong>
            <span className="mt-2 block text-[12px] text-chrome-dim">
              Restoring your workspace…
            </span>
          </span>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell grid h-screen grid-rows-[52px_1fr]">
      <TopBar />
      {/* The whole workspace shares one textured surface; the GPU canvas
          clears to transparent so panels genuinely sit on the same material. */}
      <div
        className={`app-main grid min-h-0 bg-surface bg-[radial-gradient(var(--color-canvas-dot)_1px,transparent_1.15px)] bg-[size:20px_20px] ${
          designMateOpen
            ? "grid-cols-[72px_minmax(0,1fr)_336px_390px]"
            : "grid-cols-[72px_minmax(0,1fr)_336px]"
        }`}
      >
        <Toolbar />
        <section
          className="canvas-area relative min-h-0 min-w-0"
          aria-label="Logo canvas workspace"
          onDragOver={(event) => {
            // Claim file drags so the browser doesn't navigate away.
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
            }
          }}
          onDrop={(event) => {
            const files = Array.from(event.dataTransfer.files);
            if (files.length === 0) {
              return;
            }
            event.preventDefault();
            const doc = files.find((file) =>
              file.name.toLowerCase().endsWith(OPENLOGO_EXTENSION),
            );
            if (doc) {
              openDocumentFileWithToast(doc);
            } else {
              useEditorStore
                .getState()
                .setToast("Drop a .openlogo file to open it.");
            }
          }}
        >
          <CanvasStage
            onContextMenu={({ x, y, nodeId }) =>
              setCanvasMenu({ x, y, hasNode: nodeId !== null })
            }
          />
          {canvasMenu && (
            <CanvasContextMenu
              menu={canvasMenu}
              availability={commandAvailability(selectedNodeIds)}
              onClose={() => setCanvasMenu(null)}
              onRun={runEditorCommand}
            />
          )}
          {templatePanelOpen && (
            <Suspense
              fallback={
                <aside
                  className="absolute bottom-12 left-12 top-12 z-30 w-[280px] rounded-panel border border-panel-hairline bg-panel/70 shadow-[0_18px_48px_rgb(19_16_25/0.28)]"
                  aria-label="Loading templates"
                  aria-busy="true"
                />
              }
            >
              <EditorTemplatePanel />
            </Suspense>
          )}
          <ArtboardEdgeControls />
          <ZoomControls />
          <PreviewStrip />
          <Suspense fallback={null}>
            <DesignMateCompanion />
          </Suspense>
        </section>
        <Suspense
          fallback={
            <aside
              className="border-l border-panel-hairline bg-panel/70"
              aria-label="Loading inspector"
              aria-busy="true"
            />
          }
        >
          <Inspector />
        </Suspense>
        <Suspense fallback={null}>
          <DesignMateDock />
        </Suspense>
      </div>
      <CommandPalette
        open={commandPaletteOpen}
        availability={commandAvailability(selectedNodeIds)}
        onClose={() => setCommandPaletteOpen(false)}
        onRun={runEditorCommand}
      />
      <ShortcutOverlay
        open={shortcutOverlayOpen}
        onClose={() => setShortcutOverlayOpen(false)}
      />
      <Suspense fallback={null}>
        {transformDialogOpen || loadedDialogs.transform ? (
          <TransformDialog />
        ) : null}
        {exportDialogOpen || loadedDialogs.export ? <ExportDialog /> : null}
        {documentLibraryOpen || loadedDialogs.library ? (
          <DocumentLibraryDialog />
        ) : null}
      </Suspense>
      <Toast />
    </main>
  );
}
