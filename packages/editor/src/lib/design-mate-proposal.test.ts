import {
  DocumentStore,
  createInitialDocument,
  type LogoDocument,
  type TextNode,
} from "@openlogo/core";
import {
  prepareDesignMateProposal,
  type DesignMateProposal,
  type PreparedDesignMateProposal,
} from "@openlogo/design-mate";
import { describe, expect, it, vi } from "vitest";
import {
  applyPreparedDesignMateProposal,
  createDesignMateProposalPreview,
  prepareDesignMateProposalFonts,
} from "./design-mate-proposal";
import { fontStore } from "./font-store";

function firstTextNode(document: LogoDocument): TextNode {
  const node = Object.values(document.nodes).find(
    (candidate): candidate is TextNode => candidate.type === "text",
  );
  if (!node) {
    throw new Error("Expected the test document to contain a text node.");
  }
  return node;
}

function prepare(
  document: LogoDocument,
  proposal: DesignMateProposal,
  options = { generation: 0, revision: 0 },
): PreparedDesignMateProposal {
  const result = prepareDesignMateProposal(document, proposal, options);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.prepared;
}

function decodeSvg(dataUrl: string): string {
  return decodeURIComponent(dataUrl.slice(dataUrl.indexOf(",") + 1));
}

describe("Design Mate proposal previews", () => {
  it("compares changed nodes without mutating either document", () => {
    const document = createInitialDocument();
    const text = firstTextNode(document);
    text.content = "Before";
    const prepared = prepare(document, {
      id: "test-node-preview",
      label: "Update wordmark",
      risk: "low",
      actions: [
        {
          type: "set-text-content",
          nodeId: text.id,
          content: "After",
        },
      ],
    });
    const baseBefore = structuredClone(document);
    const previewBefore = structuredClone(prepared.previewDocument);

    const preview = createDesignMateProposalPreview(document, prepared);

    expect(preview?.kind).toBe("nodes");
    expect(preview?.before.label).toContain(text.name);
    expect(decodeSvg(preview!.before.dataUrl)).toContain(">Before</text>");
    expect(decodeSvg(preview!.after.dataUrl)).toContain(">After</text>");
    expect(document).toEqual(baseBefore);
    expect(prepared.previewDocument).toEqual(previewBefore);
  });

  it("compares a variant source with its created artboard and fails closed", () => {
    const document = createInitialDocument();
    const source = document.artboards[0]!;
    const prepared = prepare(document, {
      id: "test-variant-preview",
      label: "Create icon variant",
      risk: "low",
      actions: [
        {
          type: "create-logo-variant",
          sourceArtboardId: source.id,
          purpose: "icon",
        },
      ],
    });
    const baseBefore = structuredClone(document);
    const previewBefore = structuredClone(prepared.previewDocument);

    const preview = createDesignMateProposalPreview(document, prepared);

    expect(preview?.kind).toBe("variant");
    expect(preview?.before.label).toBe(`Before · ${source.name}`);
    expect(preview?.after.label).toContain("After ·");
    expect(preview?.before.dataUrl).toMatch(/^data:image\/svg\+xml/);
    expect(preview?.after.dataUrl).toMatch(/^data:image\/svg\+xml/);
    expect(document).toEqual(baseBefore);
    expect(prepared.previewDocument).toEqual(previewBefore);

    const unavailableTarget: PreparedDesignMateProposal = {
      ...prepared,
      impact: {
        ...prepared.impact,
        createdArtboardIds: ["missing-artboard"],
      },
    };
    expect(
      createDesignMateProposalPreview(document, unavailableTarget),
    ).toBeNull();
  });

  it("compares the full artboard when creating a brief-backed wordmark", () => {
    const document = createInitialDocument();
    document.designBrief = { brandName: "Northstar" };
    const artboard = document.artboards[0]!;
    const text = firstTextNode(document);
    artboard.nodeIds = artboard.nodeIds.filter(
      (nodeId) => nodeId !== text.id,
    );
    delete document.nodes[text.id];
    const prepared = prepare(document, {
      id: "test-create-wordmark-preview",
      label: "Add the brand wordmark",
      risk: "medium",
      actions: [
        {
          type: "create-wordmark",
          artboardId: artboard.id,
          content: "Northstar",
        },
      ],
    });

    const preview = createDesignMateProposalPreview(document, prepared);
    expect(preview?.kind).toBe("nodes");
    expect(decodeSvg(preview!.before.dataUrl)).not.toContain("Northstar");
    expect(decodeSvg(preview!.after.dataUrl)).toContain(">Northstar</text>");
  });

  it("uses one bounded frame for both geometry previews", () => {
    const document = createInitialDocument();
    const text = firstTextNode(document);
    const prepared = prepare(document, {
      id: "test-geometry-preview",
      label: "Move wordmark",
      risk: "medium",
      actions: [
        {
          type: "translate-nodes",
          nodeIds: [text.id],
          dx: 40,
          dy: 10,
        },
      ],
    });

    const preview = createDesignMateProposalPreview(document, prepared);
    const before = decodeSvg(preview!.before.dataUrl);
    const after = decodeSvg(preview!.after.dataUrl);

    expect(preview?.kind).toBe("nodes");
    expect(before.match(/viewBox="([^"]+)"/)?.[1]).toBe(
      after.match(/viewBox="([^"]+)"/)?.[1],
    );
    expect(after).not.toBe(before);
  });

  it("uses one frame for bounds-changing style previews", () => {
    const document = createInitialDocument();
    const text = firstTextNode(document);
    const prepared = prepare(document, {
      id: "test-font-size-preview",
      label: "Increase wordmark size",
      risk: "medium",
      actions: [
        {
          type: "set-font-size",
          nodeId: text.id,
          fontSize: text.fontSize + 20,
        },
      ],
    });
    const preview = createDesignMateProposalPreview(document, prepared);
    const before = decodeSvg(preview!.before.dataUrl);
    const after = decodeSvg(preview!.after.dataUrl);

    expect(before.match(/viewBox="([^"]+)"/)?.[1]).toBe(
      after.match(/viewBox="([^"]+)"/)?.[1],
    );
    expect(after).not.toBe(before);
  });

  it("omits oversized SVG previews", () => {
    const document = createInitialDocument();
    const text = firstTextNode(document);
    text.content = "x".repeat(300_000);
    const prepared = prepare(document, {
      id: "test-bounded-preview",
      label: "Fade oversized wordmark",
      risk: "medium",
      actions: [
        {
          type: "set-opacity",
          nodeId: text.id,
          opacity: 0.5,
        },
      ],
    });

    expect(createDesignMateProposalPreview(document, prepared)).toBeNull();
  });

  it("loads the exact final face before approved font changes", async () => {
    const document = createInitialDocument();
    const text = firstTextNode(document);
    const prepared = prepare(document, {
      id: "test-font-warm",
      label: "Change wordmark font",
      risk: "medium",
      actions: [
        {
          type: "set-font-family",
          nodeId: text.id,
          fontFamily: "Montserrat",
        },
        {
          type: "set-font-weight",
          nodeId: text.id,
          fontWeight: 600,
        },
      ],
    });
    const ensure = vi
      .spyOn(fontStore, "ensure")
      .mockResolvedValue(new ArrayBuffer(1));

    await expect(prepareDesignMateProposalFonts(prepared)).resolves.toBe(true);

    expect(ensure).toHaveBeenCalledWith("Montserrat", 600, "normal");
    expect(createDesignMateProposalPreview(document, prepared)).toBeNull();
    ensure.mockRestore();
  });

  it("rejects unavailable font faces before apply", async () => {
    const document = createInitialDocument();
    const text = firstTextNode(document);
    const prepared = prepare(document, {
      id: "test-font-unavailable",
      label: "Use unavailable font",
      risk: "medium",
      actions: [
        {
          type: "set-font-family",
          nodeId: text.id,
          fontFamily: "Definitely Not A Catalog Family",
        },
      ],
    });
    const ensure = vi.spyOn(fontStore, "ensure");

    await expect(prepareDesignMateProposalFonts(prepared)).resolves.toBe(
      false,
    );
    expect(ensure).not.toHaveBeenCalled();
    ensure.mockRestore();
  });
});

describe("applying a prepared Design Mate proposal", () => {
  it("applies the batch once and restores the document with one undo", () => {
    const document = createInitialDocument();
    const text = firstTextNode(document);
    const store = new DocumentStore(document);
    const before = structuredClone(store.committedDocument);
    const prepared = prepare(
      store.committedDocument,
      {
        id: "test-atomic-apply",
        label: "Update wordmark",
        risk: "medium",
        actions: [
          {
            type: "set-text-content",
            nodeId: text.id,
            content: "Northstar",
          },
          {
            type: "set-letter-spacing",
            nodeId: text.id,
            letterSpacing: text.letterSpacing === 2 ? 3 : 2,
          },
        ],
      },
      {
        generation: store.documentGeneration,
        revision: store.committedRevision,
      },
    );
    const apply = vi.spyOn(store, "apply");

    expect(applyPreparedDesignMateProposal(store, prepared)).toEqual({
      status: "applied",
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(prepared.command);
    expect(store.committedDocument).toEqual(prepared.previewDocument);
    expect(store.committedRevision).toBe(1);

    store.undo();
    expect(store.committedDocument).toEqual(before);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(true);
  });

  it("rejects fingerprint, revision, and generation mismatches before apply", () => {
    const document = createInitialDocument();
    const text = firstTextNode(document);
    const prepared = prepare(document, {
      id: "test-stale-identity",
      label: "Update wordmark",
      risk: "low",
      actions: [
        {
          type: "set-text-content",
          nodeId: text.id,
          content: "Northstar",
        },
      ],
    });

    const changedDocument = structuredClone(document);
    changedDocument.nodes[text.id]!.x += 1;
    const fingerprintStore = new DocumentStore(changedDocument);
    const fingerprintApply = vi.spyOn(fingerprintStore, "apply");
    expect(
      applyPreparedDesignMateProposal(fingerprintStore, prepared),
    ).toEqual({ status: "stale" });
    expect(fingerprintApply).not.toHaveBeenCalled();

    const revisionStore = new DocumentStore(document);
    revisionStore.apply({
      type: "rename-document",
      name: `${document.name} revised`,
    });
    revisionStore.undo();
    expect(revisionStore.committedDocument).toEqual(document);
    const revisionBefore = revisionStore.committedDocument;
    const revisionApply = vi.spyOn(revisionStore, "apply");
    expect(applyPreparedDesignMateProposal(revisionStore, prepared)).toEqual({
      status: "stale",
    });
    expect(revisionApply).not.toHaveBeenCalled();
    expect(revisionStore.committedDocument).toBe(revisionBefore);

    const generationStore = new DocumentStore(document);
    generationStore.reset(structuredClone(document));
    const generationBefore = generationStore.committedDocument;
    const generationApply = vi.spyOn(generationStore, "apply");
    expect(applyPreparedDesignMateProposal(generationStore, prepared)).toEqual({
      status: "stale",
    });
    expect(generationApply).not.toHaveBeenCalled();
    expect(generationStore.committedDocument).toBe(generationBefore);
  });

  it("does not cancel a live edit when the proposal is stale", () => {
    const document = createInitialDocument();
    const text = firstTextNode(document);
    const store = new DocumentStore(document);
    const prepared = prepare(document, {
      id: "test-live-edit",
      label: "Update wordmark",
      risk: "low",
      actions: [
        {
          type: "set-text-content",
          nodeId: text.id,
          content: "Northstar",
        },
      ],
    });
    store.apply({
      type: "rename-document",
      name: `${document.name} revised`,
    });
    store.preview([{ nodeId: text.id, patch: { x: 999 } }]);
    const liveDocument = store.document;
    const committedDocument = store.committedDocument;
    const apply = vi.spyOn(store, "apply");

    expect(applyPreparedDesignMateProposal(store, prepared)).toEqual({
      status: "stale",
    });
    expect(apply).not.toHaveBeenCalled();
    expect(store.document).toBe(liveDocument);
    expect(store.document.nodes[text.id]!.x).toBe(999);
    expect(store.committedDocument).toBe(committedDocument);
  });

  it("reports a command rejected by the store", () => {
    const document = createInitialDocument();
    const text = firstTextNode(document);
    const store = new DocumentStore(document);
    const prepared = prepare(document, {
      id: "test-rejected-command",
      label: "Update wordmark",
      risk: "low",
      actions: [
        {
          type: "set-text-content",
          nodeId: text.id,
          content: "Northstar",
        },
      ],
    });
    const rejected: PreparedDesignMateProposal = {
      ...prepared,
      command: {
        type: "batch",
        commands: [{ type: "rename-document", name: document.name }],
      },
    };
    const before = store.committedDocument;
    const apply = vi.spyOn(store, "apply");

    expect(applyPreparedDesignMateProposal(store, rejected)).toEqual({
      status: "rejected",
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(store.committedDocument).toBe(before);
    expect(store.canUndo).toBe(false);
  });
});
