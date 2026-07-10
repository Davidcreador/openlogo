import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { documentToSvg } from "./lib/export";
import { getStartupMetrics, markAppStart } from "./lib/performance";
import { documentStore } from "./state/document";
import { useEditorStore } from "./state/editor-store";
import "./styles.css";

markAppStart();

if (import.meta.env.DEV) {
  // Automation/debug hook; dev builds only. CanvasStage adds `renderer`
  // once the CanvasKit surface exists.
  (window as unknown as Record<string, unknown>).__openlogo = {
    documentStore,
    editorStore: useEditorStore,
    exportSvg: () => documentToSvg(documentStore.document),
    getStartupMetrics,
  };
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
