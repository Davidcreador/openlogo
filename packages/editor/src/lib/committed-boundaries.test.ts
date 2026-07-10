import { createInitialDocument, createRectangle } from "@openlogo/core";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./export")>();
  return { ...actual, downloadTextFile: vi.fn() };
});

import { downloadTextFile } from "./export";
import { saveDocumentFile } from "./document-file";
import { runExport } from "./export-jobs";
import { documentStore } from "../state/document";

function resetFixture() {
  const document = createInitialDocument();
  const rectangle = createRectangle({ x: 25, y: 30 });
  document.nodes = { [rectangle.id]: rectangle };
  document.artboards[0] = {
    ...document.artboards[0]!,
    nodeIds: [rectangle.id],
  };
  documentStore.reset(document);
  documentStore.preview([{ nodeId: rectangle.id, patch: { x: 999 } }]);
  return rectangle;
}

describe("committed persistence boundaries", () => {
  beforeEach(() => {
    vi.mocked(downloadTextFile).mockClear();
  });

  it("saves the committed document rather than transient preview geometry", () => {
    const rectangle = resetFixture();
    saveDocumentFile();
    const contents = vi.mocked(downloadTextFile).mock.calls[0]![0];
    const saved = JSON.parse(contents) as {
      nodes: Record<string, { x: number }>;
    };
    expect(saved.nodes[rectangle.id]!.x).toBe(25);
  });

  it("exports the committed document rather than transient preview geometry", async () => {
    resetFixture();
    await Effect.runPromise(
      runExport({
        format: "svg",
        scope: "active",
        selectionIds: [],
        settings: { precision: 3, minify: false, outlineText: false },
      }),
    );
    const svg = vi.mocked(downloadTextFile).mock.calls[0]![0];
    expect(svg).toContain('x="25"');
    expect(svg).not.toContain('x="999"');
  });
});
