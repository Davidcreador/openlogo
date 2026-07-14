import { createInitialDocument, createRectangle } from "@openlogo/core";
import { describe, expect, it } from "vitest";
import { arrangeNodes } from "./object-ops";
import { documentStore } from "../state/document";

function seedDocument(count: number): string[] {
  const document = createInitialDocument();
  const ids: string[] = [];
  document.nodes = {};
  for (let i = 0; i < count; i += 1) {
    const rect = createRectangle({ x: i * 10, y: 0 });
    rect.name = `Rect ${i}`;
    document.nodes[rect.id] = rect;
    ids.push(rect.id);
  }
  document.artboards[0] = { ...document.artboards[0]!, nodeIds: [...ids] };
  documentStore.reset(document);
  return ids;
}

function order(): readonly string[] {
  return documentStore.document.artboards[0]!.nodeIds;
}

describe("arrangeNodes", () => {
  it("brings a node to the front", () => {
    const [a, b, c] = seedDocument(3);
    expect(arrangeNodes([a!], "front")).toBe(true);
    expect(order()).toEqual([b, c, a]);
  });

  it("sends a node to the back", () => {
    const [a, b, c] = seedDocument(3);
    expect(arrangeNodes([c!], "back")).toBe(true);
    expect(order()).toEqual([c, a, b]);
  });

  it("steps forward and backward one slot", () => {
    const [a, b, c] = seedDocument(3);
    arrangeNodes([a!], "forward");
    expect(order()).toEqual([b, a, c]);
    arrangeNodes([a!], "backward");
    expect(order()).toEqual([a, b, c]);
  });

  it("no-ops at the boundary without a history entry", () => {
    const [a] = seedDocument(3);
    const revision = documentStore.committedRevision;
    expect(arrangeNodes([a!], "back")).toBe(false);
    expect(documentStore.committedRevision).toBe(revision);
  });

  it("keeps relative order for multi-selection front", () => {
    const [a, b, c, d] = seedDocument(4);
    expect(arrangeNodes([a!, c!], "front")).toBe(true);
    expect(order()).toEqual([b, d, a, c]);
  });

  it("multi-selection forward does not swap selected neighbours", () => {
    const [a, b, c] = seedDocument(3);
    // a and b step past c together, staying [a, b] relative to each other.
    expect(arrangeNodes([a!, b!], "forward")).toBe(true);
    expect(order()).toEqual([c, a, b]);
  });

  it("multi-selection at the top is a no-op for forward", () => {
    const [a, b, c] = seedDocument(3);
    expect(arrangeNodes([b!, c!], "forward")).toBe(false);
    expect(order()).toEqual([a, b, c]);
  });

  it("arranges as one undoable history entry", () => {
    const [a, b, c, d] = seedDocument(4);
    const revision = documentStore.committedRevision;
    arrangeNodes([a!, b!], "front");
    expect(order()).toEqual([c, d, a, b]);
    expect(documentStore.committedRevision).toBe(revision + 1);
    documentStore.undo();
    expect(order()).toEqual([a, b, c, d]);
  });
});
