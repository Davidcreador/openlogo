import { create } from "zustand";
import type { DesignReview } from "@openlogo/core";
import { type Camera, createCamera } from "@openlogo/renderer";
import { loadPrefs, savePrefs } from "../lib/prefs";

export type Tool =
  | "select"
  | "rectangle"
  | "ellipse"
  | "triangle"
  | "polygon"
  | "star"
  | "line"
  | "arrow"
  | "path"
  | "pen"
  | "text"
  | "eyedropper"
  | "gradient"
  | "shapeBuilder";

type EditorState = {
  tool: Tool;
  selectedNodeIds: string[];
  /**
   * Key object for align/distribute (Illustrator): one member of a
   * multi-selection, marked by clicking it again, that alignment targets
   * and spacing distribution anchors. Only meaningful while it is part
   * of a 2+ selection — setSelection clears it otherwise.
   */
  keyObjectId: string | null;
  camera: Camera;
  review: DesignReview | null;
  rendererReady: boolean;
  /** Path node currently in bezier edit mode. */
  editingPathId: string | null;
  /**
   * Group scope entered via double-click (Illustrator isolation-lite).
   * Clicks resolve to that group's direct children; null = top level.
   */
  activeGroupId: string | null;
  /** Canvas viewport CSS size, kept fresh by CanvasStage's resize observer. */
  viewport: { width: number; height: number };
  /** Rotate/reflect dialog visibility (operates on the selection). */
  transformDialogOpen: boolean;
  /** Export dialog visibility. */
  exportDialogOpen: boolean;
  /** Round committed positions/dimensions to whole pixels (persisted). */
  pixelSnap: boolean;
  /** Transient status message (file open errors etc.); null = hidden. */
  toast: string | null;
  setTool: (tool: Tool) => void;
  setTransformDialogOpen: (open: boolean) => void;
  setExportDialogOpen: (open: boolean) => void;
  setPixelSnap: (on: boolean) => void;
  setToast: (message: string | null) => void;
  setEditingPathId: (id: string | null) => void;
  setActiveGroupId: (id: string | null) => void;
  setViewport: (viewport: { width: number; height: number }) => void;
  setSelection: (ids: string[]) => void;
  setKeyObjectId: (id: string | null) => void;
  setCamera: (camera: Camera) => void;
  setReview: (review: DesignReview | null) => void;
  setRendererReady: (ready: boolean) => void;
};

export const useEditorStore = create<EditorState>((set) => ({
  tool: "select",
  selectedNodeIds: [],
  keyObjectId: null,
  camera: createCamera(),
  review: null,
  rendererReady: false,
  editingPathId: null,
  activeGroupId: null,
  viewport: { width: 0, height: 0 },
  transformDialogOpen: false,
  exportDialogOpen: false,
  pixelSnap: loadPrefs().pixelSnap,
  toast: null,
  setTool: (tool) => set({ tool }),
  setTransformDialogOpen: (transformDialogOpen) => set({ transformDialogOpen }),
  setExportDialogOpen: (exportDialogOpen) => set({ exportDialogOpen }),
  setPixelSnap: (pixelSnap) => {
    savePrefs({ ...loadPrefs(), pixelSnap });
    set({ pixelSnap });
  },
  setToast: (toast) => set({ toast }),
  setEditingPathId: (editingPathId) => set({ editingPathId }),
  setActiveGroupId: (activeGroupId) => set({ activeGroupId }),
  setViewport: (viewport) => set({ viewport }),
  // A key object only survives while it remains part of a multi-selection.
  setSelection: (selectedNodeIds) =>
    set((state) => ({
      selectedNodeIds,
      keyObjectId:
        state.keyObjectId &&
        selectedNodeIds.length > 1 &&
        selectedNodeIds.includes(state.keyObjectId)
          ? state.keyObjectId
          : null,
    })),
  setKeyObjectId: (keyObjectId) => set({ keyObjectId }),
  setCamera: (camera) => set({ camera }),
  setReview: (review) => set({ review }),
  setRendererReady: (rendererReady) => set({ rendererReady }),
}));
