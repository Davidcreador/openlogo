import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { documentStore } from "./state/document";
import { useEditorStore } from "./state/editor-store";
import "./styles.css";

if (import.meta.env.DEV) {
  // Automation/debug hook; dev builds only.
  (window as unknown as Record<string, unknown>).__openlogo = {
    documentStore,
    editorStore: useEditorStore,
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
