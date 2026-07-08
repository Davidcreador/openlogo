import { create } from "zustand";
import type { DesignReview } from "@openlogo/core";
import { type Camera, createCamera } from "@openlogo/renderer";

export type Tool = "select" | "rectangle" | "ellipse" | "path" | "text";

type EditorState = {
  tool: Tool;
  selectedNodeIds: string[];
  camera: Camera;
  review: DesignReview | null;
  rendererReady: boolean;
  setTool: (tool: Tool) => void;
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
  setTool: (tool) => set({ tool }),
  setSelection: (selectedNodeIds) => set({ selectedNodeIds }),
  setCamera: (camera) => set({ camera }),
  setReview: (review) => set({ review }),
  setRendererReady: (rendererReady) => set({ rendererReady }),
}));
