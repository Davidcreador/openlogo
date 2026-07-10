export type StartupMetrics = {
  readonly documentReadyMs: number | null;
  readonly rendererReadyMs: number | null;
  readonly editorReadyMs: number | null;
};

const START_MARK = "openlogo:start";
const DOCUMENT_MARK = "openlogo:document-ready";
const RENDERER_MARK = "openlogo:renderer-ready";
const EDITOR_MARK = "openlogo:editor-ready";

function browserPerformance(): Performance | null {
  return typeof performance === "undefined" ? null : performance;
}

function hasMark(name: string): boolean {
  return (browserPerformance()?.getEntriesByName(name, "mark").length ?? 0) > 0;
}

function markOnce(name: string, startTime?: number): void {
  const perf = browserPerformance();
  if (!perf || hasMark(name)) {
    return;
  }
  try {
    perf.mark(name, startTime === undefined ? undefined : { startTime });
  } catch {
    // Performance marks are diagnostics only; privacy modes must not affect
    // the editor's ability to start.
  }
}

function measureOnce(name: string, end: string): void {
  const perf = browserPerformance();
  if (!perf || perf.getEntriesByName(name, "measure").length > 0) {
    return;
  }
  try {
    perf.measure(name, START_MARK, end);
  } catch {
    // Missing/blocked marks are safe to ignore.
  }
}

/** Establish a navigation-relative baseline even when this module loads late. */
export function markAppStart(): void {
  markOnce(START_MARK, 0);
}

export function markDocumentReady(): void {
  markAppStart();
  markOnce(DOCUMENT_MARK);
  measureOnce("openlogo:time-to-document", DOCUMENT_MARK);
  publishDomMetric("openlogoDocumentReadyMs", "openlogo:time-to-document");
  maybeMarkEditorReady();
}

export function markRendererReady(): void {
  markAppStart();
  markOnce(RENDERER_MARK);
  measureOnce("openlogo:time-to-renderer", RENDERER_MARK);
  publishDomMetric("openlogoRendererReadyMs", "openlogo:time-to-renderer");
  maybeMarkEditorReady();
}

function maybeMarkEditorReady(): void {
  if (!hasMark(DOCUMENT_MARK) || !hasMark(RENDERER_MARK)) {
    return;
  }
  markOnce(EDITOR_MARK);
  measureOnce("openlogo:time-to-editor", EDITOR_MARK);
  publishDomMetric("openlogoEditorReadyMs", "openlogo:time-to-editor");
}

function duration(name: string): number | null {
  const entry = browserPerformance()?.getEntriesByName(name, "measure")[0];
  return entry ? Math.round(entry.duration * 10) / 10 : null;
}

function publishDomMetric(key: string, measureName: string): void {
  if (typeof document === "undefined") {
    return;
  }
  const value = duration(measureName);
  if (value !== null) {
    document.documentElement.dataset[key] = String(value);
  }
}

/** Read-only diagnostics for browser smoke tests and local profiling. */
export function getStartupMetrics(): StartupMetrics {
  return {
    documentReadyMs: duration("openlogo:time-to-document"),
    rendererReadyMs: duration("openlogo:time-to-renderer"),
    editorReadyMs: duration("openlogo:time-to-editor"),
  };
}
