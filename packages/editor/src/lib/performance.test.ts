import { afterEach, describe, expect, it } from "vitest";
import {
  getStartupMetrics,
  markAppStart,
  markDocumentReady,
  markRendererReady,
} from "./performance";

afterEach(() => {
  performance.clearMarks();
  performance.clearMeasures();
});

describe("startup performance milestones", () => {
  it("records partial readiness without claiming the whole editor is ready", () => {
    markAppStart();
    markDocumentReady();

    expect(getStartupMetrics()).toMatchObject({
      rendererReadyMs: null,
      editorReadyMs: null,
    });
    expect(getStartupMetrics().documentReadyMs).not.toBeNull();
  });

  it("records editor readiness only after document and renderer are ready", () => {
    markRendererReady();
    expect(getStartupMetrics().editorReadyMs).toBeNull();

    markDocumentReady();
    const metrics = getStartupMetrics();
    expect(metrics.documentReadyMs).not.toBeNull();
    expect(metrics.rendererReadyMs).not.toBeNull();
    expect(metrics.editorReadyMs).not.toBeNull();

    // StrictMode/HMR must not create duplicate measures.
    markDocumentReady();
    markRendererReady();
    expect(
      performance.getEntriesByName("openlogo:time-to-editor", "measure"),
    ).toHaveLength(1);
  });
});
