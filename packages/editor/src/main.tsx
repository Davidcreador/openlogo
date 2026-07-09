import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { documentToSvg } from "./lib/export";
import { documentStore } from "./state/document";
import { useEditorStore } from "./state/editor-store";
import "./styles.css";

if (import.meta.env.DEV) {
  // Automation/debug hook; dev builds only. CanvasStage adds `renderer`
  // once the CanvasKit surface exists.
  (window as unknown as Record<string, unknown>).__openlogo = {
    documentStore,
    editorStore: useEditorStore,
    exportSvg: () => documentToSvg(documentStore.document),
  };
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
