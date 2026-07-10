import {
  analyzeLogoDocument,
  createInitialDocument,
  type LogoDocument,
  type TextNode,
} from "@openlogo/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  DESIGN_CONTEXT_LIMITS,
  buildDesignContext,
  buildDocumentIdentity,
  collectDesignMateReview,
  createFakeDesignMateProvider,
  heuristicDesignMateProvider,
  makeDesignMateProviderError,
  orchestrateDesignMateReview,
  prepareDesignMateReviewRequest,
  type DesignMateReviewEvent,
  type DesignMateStreamResult,
} from "./index";

function cloneDocument(document: LogoDocument): LogoDocument {
  return JSON.parse(JSON.stringify(document)) as LogoDocument;
}

async function drain(
  stream: AsyncGenerator<
    DesignMateReviewEvent,
    DesignMateStreamResult,
    void
  >,
): Promise<{
  readonly events: DesignMateReviewEvent[];
  readonly result: DesignMateStreamResult;
}> {
  const events: DesignMateReviewEvent[] = [];
  while (true) {
    const next = await stream.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

function makeLargeDocument(): {
  readonly document: LogoDocument;
  readonly selectedNodeIds: string[];
} {
  const document = createInitialDocument();
  const activeArtboard = document.artboards.find(
    (artboard) => artboard.id === document.activeArtboardId,
  )!;
  const template = Object.values(document.nodes).find(
    (node): node is TextNode => node.type === "text",
  )!;
  const nodes = { ...document.nodes };
  const selectedNodeIds: string[] = [];

  for (let index = 0; index < DESIGN_CONTEXT_LIMITS.selectedNodes + 8; index += 1) {
    const id = `node_context_${String(index).padStart(2, "0")}`;
    const node: TextNode = {
      ...template,
      id,
      name: `Selected ${index} ${"n".repeat(DESIGN_CONTEXT_LIMITS.nameLength)}`,
      x: index * 4,
      content: `${index}:${"x".repeat(
        DESIGN_CONTEXT_LIMITS.textContentLength + 20,
      )}`,
      fontFamily: `Family ${index}`,
      fontSize: 20 + index,
      fontWeight: 300 + index,
    };
    nodes[id] = node;
    selectedNodeIds.push(id);
  }

  const artboards = [
    {
      ...activeArtboard,
      nodeIds: [...activeArtboard.nodeIds, ...selectedNodeIds],
    },
    ...Array.from(
      { length: DESIGN_CONTEXT_LIMITS.variants + 4 },
      (_, index) => ({
        ...activeArtboard,
        id: `artboard_context_${index}`,
        name: `Variant ${index}`,
        nodeIds: [],
      }),
    ),
  ];

  return {
    document: {
      ...document,
      artboards,
      nodes,
      palettes: [
        {
          id: "palette_context",
          name: "Context colors",
          colors: Array.from(
            { length: DESIGN_CONTEXT_LIMITS.paletteColors + 9 },
            (_, index) => `#${index.toString(16).padStart(6, "0")}`,
          ),
        },
      ],
      designBrief: {
        brandName: "B".repeat(DESIGN_CONTEXT_LIMITS.nameLength + 10),
        notes: "N".repeat(DESIGN_CONTEXT_LIMITS.briefProseLength + 10),
        attributes: Array.from(
          { length: DESIGN_CONTEXT_LIMITS.briefListItems + 5 },
          (_, index) => `attribute-${index}`,
        ),
      },
    },
    selectedNodeIds,
  };
}

describe("document identity", () => {
  it("is stable across equivalent object-key insertion order", () => {
    const document = createInitialDocument();
    const reordered = cloneDocument(document);
    reordered.nodes = Object.fromEntries(
      Object.entries(reordered.nodes).reverse(),
    );

    const originalIdentity = buildDocumentIdentity(document, {
      generation: 4,
      revision: 9,
    });
    const reorderedIdentity = buildDocumentIdentity(reordered, {
      generation: 99,
      revision: 100,
    });

    expect(reorderedIdentity.contentFingerprint).toBe(
      originalIdentity.contentFingerprint,
    );
    expect(originalIdentity).toMatchObject({
      documentId: document.id,
      schemaVersion: document.schemaVersion,
      generation: 4,
      revision: 9,
    });
  });

  it("changes when committed node content changes without changing counts", () => {
    const document = createInitialDocument();
    const changed = cloneDocument(document);
    const nodeId = changed.artboards[0]!.nodeIds[0]!;
    changed.nodes[nodeId] = {
      ...changed.nodes[nodeId]!,
      x: changed.nodes[nodeId]!.x + 0.25,
    };

    const options = { generation: 0, revision: 0 };
    expect(buildDocumentIdentity(changed, options).contentFingerprint).not.toBe(
      buildDocumentIdentity(document, options).contentFingerprint,
    );
  });
});

describe("design context", () => {
  it("falls back to the active artboard when selection ids are stale", () => {
    const document = createInitialDocument();
    const request = prepareDesignMateReviewRequest(
      document,
      { selectedNodeIds: ["missing-node"] },
      { scope: "selection", generation: 0, revision: 0 },
    );

    expect(request.scope).toBe("active-artboard");
    expect(request.context.scope).toBe("active-artboard");
    expect(request.context.metrics.selectedNodeCount).toBe(0);
  });

  it("bounds every expandable projection and reports truncation", () => {
    const { document, selectedNodeIds } = makeLargeDocument();
    const context = buildDesignContext(
      document,
      { selectedNodeIds },
      { scope: "selection" },
    );

    expect(context.variants).toHaveLength(DESIGN_CONTEXT_LIMITS.variants);
    expect(context.paletteColors).toHaveLength(
      DESIGN_CONTEXT_LIMITS.paletteColors,
    );
    expect(context.typography.fontFamilies).toHaveLength(
      DESIGN_CONTEXT_LIMITS.typographyFamilies,
    );
    expect(context.typography.styles).toHaveLength(
      DESIGN_CONTEXT_LIMITS.typographyStyles,
    );
    expect(context.selectedNodes).toHaveLength(
      DESIGN_CONTEXT_LIMITS.selectedNodes,
    );
    expect(context.designBrief?.attributes).toHaveLength(
      DESIGN_CONTEXT_LIMITS.briefListItems,
    );
    expect(context.designBrief?.notes).toHaveLength(
      DESIGN_CONTEXT_LIMITS.briefProseLength,
    );
    expect(context.truncation).toMatchObject({
      designBrief: true,
      variants: true,
      paletteColors: true,
      typographyFamilies: true,
      typographyStyles: true,
      selectedNodes: true,
      selectedNodeText: true,
    });
    expect(context.selectionFrame).not.toBeNull();
    expect(context.document).not.toHaveProperty("nodes");
    expect(context).not.toHaveProperty("nodes");
    expect(JSON.parse(JSON.stringify(context))).toEqual(context);
  });
});

describe("providers and orchestration", () => {
  it("makes the heuristic provider exactly match core analysis", async () => {
    const document = createInitialDocument();
    const selectedNodeIds = [document.artboards[0]!.nodeIds[0]!];
    const request = prepareDesignMateReviewRequest(
      document,
      { selectedNodeIds },
      { scope: "selection", generation: 2, revision: 7 },
    );

    const provided = await Effect.runPromise(
      heuristicDesignMateProvider.review(request),
    );
    expect(provided).toEqual(
      analyzeLogoDocument(document, {
        scope: "selection",
        selectionIds: selectedNodeIds,
      }),
    );
  });

  it("emits a stable success sequence with one event per finding", async () => {
    const document = createInitialDocument();
    const selection = { selectedNodeIds: [] };
    const review = analyzeLogoDocument(document, {
      scope: "active-artboard",
    });
    const provider = createFakeDesignMateProvider({ review });

    const collected = await collectDesignMateReview(document, selection, {
      generation: 1,
      revision: 3,
      scope: "active-artboard",
      provider,
    });

    expect(collected.events.map((event) => event.type)).toEqual([
      "started",
      "context",
      "summary",
      ...review.findings.map(() => "finding"),
      "completed",
    ]);
    expect(
      collected.events
        .filter((event) => event.type === "finding")
        .map((event) => event.finding),
    ).toEqual(review.findings);
    expect(collected.review).toEqual(review);
    expect(collected.scope).toBe("active-artboard");
    expect(provider.requests).toHaveLength(1);
  });

  it("emits failed after context and does not emit completion", async () => {
    const document = createInitialDocument();
    const error = makeDesignMateProviderError(
      "failing-test-provider",
      "Expected provider failure.",
      { retryable: true },
    );
    const provider = createFakeDesignMateProvider({
      id: "failing-test-provider",
      error,
    });
    const request = prepareDesignMateReviewRequest(
      document,
      { selectedNodeIds: [] },
      { generation: 0, revision: 0 },
    );

    const result = await drain(orchestrateDesignMateReview(request, provider));

    expect(result.events.map((event) => event.type)).toEqual([
      "started",
      "context",
      "failed",
    ]);
    expect(result.events[2]).toEqual({ type: "failed", error });
    expect(result.result).toMatchObject({ status: "failed", error });
    await expect(
      collectDesignMateReview(document, { selectedNodeIds: [] }, {
        generation: 0,
        revision: 0,
        provider,
      }),
    ).rejects.toEqual(error);
  });

  it("does not mutate the committed document", async () => {
    const document = createInitialDocument();
    const selectedNodeIds = [...document.artboards[0]!.nodeIds];
    const before = JSON.stringify(document);

    buildDocumentIdentity(document, { generation: 0, revision: 1 });
    buildDesignContext(document, { selectedNodeIds }, { scope: "selection" });
    await collectDesignMateReview(document, { selectedNodeIds }, {
      generation: 0,
      revision: 1,
      scope: "selection",
    });

    expect(JSON.stringify(document)).toBe(before);
  });
});
