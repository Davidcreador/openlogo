import { describe, expect, it, vi } from "vitest";
import type { Command } from "./commands";
import { createInitialDocument } from "./factory";
import { getActiveArtboard } from "./queries";
import { DocumentStore, type DocumentChangeKind } from "./store";

function firstNodeId(store: DocumentStore): string {
  return getActiveArtboard(store.document).nodeIds[0]!;
}

describe("DocumentStore", () => {
  it("apply + undo + redo round-trips", () => {
    const store = new DocumentStore(createInitialDocument());
    const nodeId = firstNodeId(store);
    const originalX = store.document.nodes[nodeId]!.x;

    store.apply({
      type: "update-nodes",
      updates: [{ nodeId, patch: { x: 500 } }],
    });
    expect(store.document.nodes[nodeId]!.x).toBe(500);
    expect(store.canUndo).toBe(true);

    store.undo();
    expect(store.document.nodes[nodeId]!.x).toBe(originalX);
    expect(store.canRedo).toBe(true);

    store.redo();
    expect(store.document.nodes[nodeId]!.x).toBe(500);
  });

  it("preview does not create history entries", () => {
    const store = new DocumentStore(createInitialDocument());
    const nodeId = firstNodeId(store);

    store.preview([{ nodeId, patch: { x: 100 } }]);
    store.preview([{ nodeId, patch: { x: 200 } }]);

    expect(store.document.nodes[nodeId]!.x).toBe(200);
    expect(store.canUndo).toBe(false);
  });

  it("syncs derived text height without adding undo history", () => {
    const store = new DocumentStore(createInitialDocument());
    const text = Object.values(store.document.nodes).find(
      (node) => node.type === "text",
    )!;
    const listener = vi.fn();
    store.subscribe(listener);

    store.syncTextHeight(text.id, 87.25);

    expect(store.document.nodes[text.id]!.height).toBe(87.25);
    expect(store.committedDocument.nodes[text.id]!.height).toBe(87.25);
    expect(store.canUndo).toBe(false);
    expect(store.committedRevision).toBe(1);
    expect(listener).toHaveBeenCalledWith(store.document, "committed");
  });

  it("does not sync derived text height over an active preview", () => {
    const store = new DocumentStore(createInitialDocument());
    const text = Object.values(store.document.nodes).find(
      (node) => node.type === "text",
    )!;
    const originalHeight = text.height;
    store.preview([{ nodeId: text.id, patch: { fontSize: 80 } }]);

    store.syncTextHeight(text.id, 120);

    expect(store.committedDocument.nodes[text.id]!.height).toBe(originalHeight);
    expect(store.document.nodes[text.id]).toMatchObject({ fontSize: 80 });
  });

  it("preview stacks on committed state, not on previous previews", () => {
    const store = new DocumentStore(createInitialDocument());
    const nodeId = firstNodeId(store);
    const originalY = store.document.nodes[nodeId]!.y;

    store.preview([{ nodeId, patch: { x: 100 } }]);
    store.preview([{ nodeId, patch: { y: 300 } }]);

    // Second preview replaced the first; x must be back to committed value.
    expect(store.document.nodes[nodeId]!.y).toBe(300);
    expect(store.document.nodes[nodeId]!.x).not.toBe(100);
    expect(originalY).not.toBe(300);
  });

  it("cancelPreview restores committed document", () => {
    const store = new DocumentStore(createInitialDocument());
    const nodeId = firstNodeId(store);
    const originalX = store.document.nodes[nodeId]!.x;

    store.preview([{ nodeId, patch: { x: 800 } }]);
    store.cancelPreview();

    expect(store.document.nodes[nodeId]!.x).toBe(originalX);
  });

  it("apply after preview commits from the committed base", () => {
    const store = new DocumentStore(createInitialDocument());
    const nodeId = firstNodeId(store);

    store.preview([{ nodeId, patch: { x: 123 } }]);
    store.apply({
      type: "update-nodes",
      updates: [{ nodeId, patch: { x: 123 } }],
    });

    expect(store.document.nodes[nodeId]!.x).toBe(123);
    store.undo();
    expect(store.document.nodes[nodeId]!.x).not.toBe(123);
  });

  it("notifies subscribers and supports unsubscribe", () => {
    const store = new DocumentStore(createInitialDocument());
    const nodeId = firstNodeId(store);
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });

    store.apply({
      type: "update-nodes",
      updates: [{ nodeId, patch: { x: 1 } }],
    });
    expect(calls).toBe(1);

    unsubscribe();
    store.undo();
    expect(calls).toBe(1);
  });

  it("labels apply, undo, and redo as committed changes", () => {
    const store = new DocumentStore(createInitialDocument());
    const nodeId = firstNodeId(store);
    const kinds: DocumentChangeKind[] = [];
    store.subscribe((_document, kind) => kinds.push(kind));

    store.apply({ type: "update-nodes", updates: [{ nodeId, patch: { x: 1 } }] });
    expect(store.committedDocument).toBe(store.document);
    store.undo();
    store.redo();

    expect(kinds).toEqual(["committed", "committed", "committed"]);
  });

  it("labels previews as transient and reset as committed", () => {
    const store = new DocumentStore(createInitialDocument());
    const nodeId = firstNodeId(store);
    const originalX = store.document.nodes[nodeId]!.x;
    const originalDocument = store.document;
    const kinds: DocumentChangeKind[] = [];
    store.subscribe((_document, kind) => kinds.push(kind));

    store.preview([{ nodeId, patch: { x: 800 } }]);
    expect(store.committedDocument).toBe(originalDocument);
    expect(store.document).not.toBe(originalDocument);
    store.cancelPreview();
    expect(store.document.nodes[nodeId]!.x).toBe(originalX);

    store.preview([{ nodeId, patch: { x: 900 } }]);

    const replacement = createInitialDocument();
    store.reset(replacement);

    expect(kinds).toEqual(["preview", "preview", "preview", "committed"]);
    expect(store.document).toBe(replacement);
    expect(store.committedDocument).toBe(store.document);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
  });

  it("new apply clears the redo stack", () => {
    const store = new DocumentStore(createInitialDocument());
    const nodeId = firstNodeId(store);

    store.apply({ type: "update-nodes", updates: [{ nodeId, patch: { x: 1 } }] });
    store.undo();
    store.apply({ type: "update-nodes", updates: [{ nodeId, patch: { x: 2 } }] });

    expect(store.canRedo).toBe(false);
  });

  it("increments its identity generation only when a document is reset", () => {
    const store = new DocumentStore(createInitialDocument());
    const generation = store.documentGeneration;
    const nodeId = firstNodeId(store);
    store.apply({
      type: "update-nodes",
      updates: [{ nodeId, patch: { x: 42 } }],
    });
    expect(store.documentGeneration).toBe(generation);

    store.reset(createInitialDocument());
    expect(store.documentGeneration).toBe(generation + 1);
  });

  it("tracks successful committed transitions within each generation", () => {
    const store = new DocumentStore(createInitialDocument());
    const nodeId = firstNodeId(store);
    const generation = store.documentGeneration;
    expect(store.committedRevision).toBe(0);

    store.preview([{ nodeId, patch: { x: 700 } }]);
    store.cancelPreview();
    store.apply({
      type: "set-active-artboard",
      artboardId: "missing-artboard",
    });
    store.apply({
      type: "set-active-artboard",
      artboardId: store.document.activeArtboardId,
    });
    store.apply({ type: "rename-document", name: store.document.name });
    store.apply({
      type: "update-palette",
      paletteId: store.document.palettes[0]!.id,
      colors: [...store.document.palettes[0]!.colors],
    });
    expect(store.committedRevision).toBe(0);

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      store.apply({
        type: "batch",
        commands: [{ type: "malformed-command" } as unknown as Command],
      });
    } finally {
      error.mockRestore();
    }
    expect(store.committedRevision).toBe(0);

    store.apply({
      type: "update-brief",
      brief: { brandName: " Northstar ", attributes: ["bold", "bold"] },
    });
    expect(store.committedRevision).toBe(1);

    store.apply({
      type: "update-brief",
      brief: { attributes: [" bold "], brandName: "Northstar" },
    });
    expect(store.committedRevision).toBe(1);

    store.undo();
    expect(store.committedRevision).toBe(2);
    store.redo();
    expect(store.committedRevision).toBe(3);

    store.reset(createInitialDocument());
    expect(store.documentGeneration).toBe(generation + 1);
    expect(store.committedRevision).toBe(0);
    store.undo();
    store.redo();
    expect(store.committedRevision).toBe(0);
  });

  it("sanitizes previews and does not record rejected no-op commands", () => {
    const store = new DocumentStore(createInitialDocument());
    const nodeId = firstNodeId(store);
    const original = store.document.nodes[nodeId]!;
    store.preview([
      {
        nodeId,
        patch: { x: Number.NaN, width: 0, opacity: -2 },
      },
    ]);
    expect(store.document.nodes[nodeId]).toMatchObject({
      x: original.x,
      width: 0.01,
      opacity: 0,
    });
    expect(store.canUndo).toBe(false);

    store.apply({
      type: "set-active-artboard",
      artboardId: "missing-artboard",
    });
    expect(store.canUndo).toBe(false);
  });
});
