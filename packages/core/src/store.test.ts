import { describe, expect, it } from "vitest";
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
});
