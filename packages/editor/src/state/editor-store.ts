import { create } from "zustand";
import type { DesignReview } from "@openlogo/core";
import { type Camera, createCamera } from "@openlogo/renderer";

export type Tool =
  | "select"
  | "rectangle"
  | "ellipse"
  | "path"
  | "pen"
  | "text";

type EditorState = {
  tool: Tool;
  selectedNodeIds: string[];
  camera: Camera;
  review: DesignReview | null;
  rendererReady: boolean;
  /** Path node currently in bezier edit mode. */
  editingPathId: string | null;
  /** Canvas viewport CSS size, kept fresh by CanvasStage's resize observer. */
  viewport: { width: number; height: number };
  setTool: (tool: Tool) => void;
  setEditingPathId: (id: string | null) => void;
  setViewport: (viewport: { width: number; height: number }) => void;
  setSelection: (ids: string[]) => void;
  setCamera: (camera: Camera) => void;
  setReview: (review: DesignReview | null) => void;
  setRendererReady: (ready: boolean) => void;
};

export const useEditorStore = create<EditorState>((set) => ({
  tool: "select",
  selectedNodeIds: [],
  camera: createCamera(),
  review: null,
  rendererReady: false,
  editingPathId: null,
  viewport: { width: 0, height: 0 },
  setTool: (tool) => set({ tool }),
  setEditingPathId: (editingPathId) => set({ editingPathId }),
  setViewport: (viewport) => set({ viewport }),
  setSelection: (selectedNodeIds) => set({ selectedNodeIds }),
  setCamera: (camera) => set({ camera }),
  setReview: (review) => set({ review }),
  setRendererReady: (rendererReady) => set({ rendererReady }),
}));
