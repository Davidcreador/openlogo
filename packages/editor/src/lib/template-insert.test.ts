import {
  DocumentStore,
  createInitialDocument,
  parseDocument,
  type GroupNode,
  type LogoDocument,
} from "@openlogo/core";
import { generate } from "@openlogo/foundry";
import { describe, expect, it } from "vitest";
import { createTemplateInsert } from "./template-insert";

function emptyDocument(): LogoDocument {
  const document = createInitialDocument();
  document.nodes = {};
  document.artboards[0]!.nodeIds = [];
  return document;
}

describe("template insertion", () => {
  it("inserts one remapped group as one undoable command", () => {
    const original = emptyDocument();
    const proposal = generate({
      brandName: "Arc & Anchor",
      tagline: "Est. 2026",
      archetypeId: "circular-seal",
      seed: 73,
    });
    const insertion = createTemplateInsert(original, proposal, "Circular seal");
    expect(insertion).not.toBeNull();

    const store = new DocumentStore(original);
    store.apply(insertion!.command);

    expect(store.committedRevision).toBe(1);
    expect(store.document.artboards[0]!.nodeIds).toEqual([insertion!.groupId]);
    const group = store.document.nodes[insertion!.groupId] as GroupNode;
    expect(group.type).toBe("group");
    expect(group.children).toHaveLength(proposal.artboards[0]!.nodeIds.length);
    expect(Object.keys(store.document.nodes)).toHaveLength(
      Object.keys(proposal.nodes).length + 1,
    );
    for (const node of Object.values(store.document.nodes)) {
      if (node.type === "text" && node.onPath) {
        expect(store.document.nodes[node.onPath.pathId]?.type).toBe("path");
      }
    }
    expect(parseDocument(store.document)).toEqual(store.document);

    store.undo();
    expect(store.document).toEqual(original);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(true);

    store.redo();
    expect(store.document.artboards[0]!.nodeIds).toEqual([insertion!.groupId]);
  });

  it("materializes fresh ids for repeated inserts", () => {
    const original = emptyDocument();
    const proposal = generate({
      brandName: "Repeat Works",
      archetypeId: "wordmark",
      seed: 19,
    });
    const store = new DocumentStore(original);
    const first = createTemplateInsert(store.document, proposal, "Wordmark")!;
    store.apply(first.command);
    const second = createTemplateInsert(store.document, proposal, "Wordmark")!;
    store.apply(second.command);

    expect(second.groupId).not.toBe(first.groupId);
    expect(new Set(Object.keys(store.document.nodes)).size).toBe(
      Object.keys(store.document.nodes).length,
    );
    expect(store.document.artboards[0]!.nodeIds).toEqual([
      first.groupId,
      second.groupId,
    ]);
  });
});
