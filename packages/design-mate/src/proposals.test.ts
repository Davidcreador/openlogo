import {
  ARTBOARD_GAP,
  applyCommand,
  createArtboard,
  createGroup,
  createInitialDocument,
} from "@openlogo/core";
import type {
  LogoDocument,
  PathNode,
  TextNode,
} from "@openlogo/core";
import { describe, expect, it } from "vitest";
import {
  DESIGN_MATE_MUTATION_TOOLS,
  DESIGN_MATE_PROPOSAL_LIMITS,
  isDesignMateProposalStale,
  isValidDesignMateProposal,
  prepareDesignMateProposal,
  type DesignMateAction,
  type DesignMateProposal,
  type PrepareDesignMateProposalResult,
  type PreparedDesignMateProposal,
} from "./index";

function textNode(document: LogoDocument): TextNode {
  return Object.values(document.nodes).find(
    (node): node is TextNode => node.type === "text",
  )!;
}

function pathNode(document: LogoDocument): PathNode {
  return Object.values(document.nodes).find(
    (node): node is PathNode => node.type === "path",
  )!;
}

function proposal(
  actions: readonly DesignMateAction[],
  overrides: Partial<DesignMateProposal> = {},
): DesignMateProposal {
  return {
    id: "proposal-test",
    label: "Apply safe changes",
    rationale: "A deterministic test proposal.",
    risk: "medium",
    sourceFindingIds: ["finding-test"],
    actions,
    ...overrides,
  };
}

function getPrepared(
  result: PrepareDesignMateProposalResult,
): PreparedDesignMateProposal {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.prepared;
}

function expectFailure(result: PrepareDesignMateProposalResult): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected proposal preparation to fail.");
  }
  expect(result.error._tag).toBe("DesignMateProposalError");
  expect(result.error.message.length).toBeLessThanOrEqual(
    DESIGN_MATE_PROPOSAL_LIMITS.errorMessageLength,
  );
}

function expectDeepFrozen(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeepFrozen(Reflect.get(value, key), seen);
  }
}

describe("Design Mate proposal validation", () => {
  it("accepts only exact bounded proposal and action shapes", () => {
    const document = createInitialDocument();
    const text = textNode(document);
    const valid = proposal([
      {
        type: "set-text-content",
        nodeId: text.id,
        content: "Northstar",
      },
    ]);
    expect(isValidDesignMateProposal(valid)).toBe(true);

    const invalid: unknown[] = [
      { ...valid, extra: true },
      { ...valid, actions: [] },
      {
        ...valid,
        id: "x".repeat(DESIGN_MATE_PROPOSAL_LIMITS.proposalIdLength + 1),
      },
      {
        ...valid,
        sourceFindingIds: ["duplicate", "duplicate"],
      },
      {
        ...valid,
        actions: [
          {
            type: "set-text-content",
            nodeId: text.id,
            content: "   ",
          },
        ],
      },
      {
        ...valid,
        risk: "low",
        actions: [
          {
            type: "set-fill-color",
            nodeId: pathNode(document).id,
            color: "#000000",
          },
        ],
      },
      {
        ...valid,
        actions: [
          {
            type: "set-text-content",
            nodeId: text.id,
            content: "Northstar",
            extra: true,
          },
        ],
      },
      {
        ...valid,
        actions: [
          {
            type: "set-fill-color",
            nodeId: text.id,
            color: { type: "linear-gradient", stops: [] },
          },
        ],
      },
      {
        ...valid,
        actions: [
          {
            type: "set-letter-spacing",
            nodeId: text.id,
            letterSpacing: Number.POSITIVE_INFINITY,
          },
        ],
      },
      {
        ...valid,
        actions: [
          {
            type: "set-letter-spacing",
            nodeId: text.id,
            letterSpacing:
              DESIGN_MATE_PROPOSAL_LIMITS.maximumLetterSpacing + 1,
          },
        ],
      },
      {
        ...valid,
        actions: [
          {
            type: "create-logo-variant",
            sourceArtboardId: document.activeArtboardId,
            purpose: "badge",
          },
        ],
      },
      {
        ...valid,
        actions: Array.from(
          { length: DESIGN_MATE_PROPOSAL_LIMITS.actions + 1 },
          () => ({
            type: "set-text-content",
            nodeId: text.id,
            content: "Northstar",
          }),
        ),
      },
    ];

    for (const candidate of invalid) {
      expect(isValidDesignMateProposal(candidate)).toBe(false);
      expectFailure(
        prepareDesignMateProposal(document, candidate, {
          generation: 0,
          revision: 0,
        }),
      );
    }
  });

  it("fails closed rather than throwing on hostile provider values", () => {
    const document = createInitialDocument();
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("provider trap");
        },
      },
    );

    expect(() =>
      prepareDesignMateProposal(document, hostile, {
        generation: 0,
        revision: 0,
      }),
    ).not.toThrow();
    expectFailure(
      prepareDesignMateProposal(document, hostile, {
        generation: 0,
        revision: 0,
      }),
    );
  });

  it("publishes a deeply read-only registry for the closed action surface", () => {
    expect(Object.keys(DESIGN_MATE_MUTATION_TOOLS).sort()).toEqual([
      "align-nodes",
      "create-logo-variant",
      "distribute-nodes",
      "rotate-nodes",
      "scale-nodes",
      "set-fill-color",
      "set-font-family",
      "set-font-size",
      "set-font-weight",
      "set-letter-spacing",
      "set-opacity",
      "set-stroke-color",
      "set-stroke-width",
      "set-text-content",
      "translate-nodes",
    ]);
    expectDeepFrozen(DESIGN_MATE_MUTATION_TOOLS);
    for (const metadata of Object.values(DESIGN_MATE_MUTATION_TOOLS)) {
      expect(["low", "medium", "high"]).toContain(metadata.risk);
      expect(metadata.description.length).toBeGreaterThan(0);
    }
  });
});

describe("prepareDesignMateProposal", () => {
  it("compiles every action sequentially into one detached atomic preview", () => {
    const document = createInitialDocument();
    const text = textNode(document);
    const path = pathNode(document);
    const documentBefore = structuredClone(document);
    const input = {
      id: "proposal-all-actions",
      label: "Apply all safe changes",
      rationale: "Exercises the complete mutation surface.",
      risk: "medium",
      sourceFindingIds: ["finding-all-actions"],
      actions: [
        {
          type: "set-text-content",
          nodeId: text.id,
          content: "Northstar",
        },
        {
          type: "set-fill-color",
          nodeId: path.id,
          color: "#ABC",
        },
        {
          type: "set-letter-spacing",
          nodeId: text.id,
          letterSpacing: 2.5,
        },
        {
          type: "create-logo-variant",
          sourceArtboardId: document.activeArtboardId,
          purpose: "icon",
        },
      ],
    };

    const prepared = getPrepared(
      prepareDesignMateProposal(document, input, {
        generation: 2,
        revision: 7,
      }),
    );

    expect(document).toEqual(documentBefore);
    expect(prepared.proposal).not.toBe(input);
    expect(prepared.command).toMatchObject({
      type: "batch",
      label: input.label,
    });
    expect(prepared.command.commands.map((command) => command.type)).toEqual([
      "update-nodes",
      "update-nodes",
      "update-nodes",
      "add-artboard",
    ]);
    expect(prepared.previewDocument.nodes[text.id]).toMatchObject({
      content: "Northstar",
      letterSpacing: 2.5,
    });
    expect(prepared.previewDocument.nodes[path.id]!.fill).toEqual({
      type: "solid",
      color: "#aabbcc",
    });
    expect(
      prepared.previewDocument.artboards.some(
        (artboard) => artboard.purpose === "icon",
      ),
    ).toBe(true);
    expect(prepared.previewDocument.activeArtboardId).toBe(
      document.activeArtboardId,
    );
    expect(prepared.impact.changedNodeIds).toEqual([text.id, path.id]);
    expect(prepared.impact.createdArtboardIds).toHaveLength(1);
    expect(prepared.impact.summaries).toHaveLength(4);

    const applied = applyCommand(document, prepared.command).document;
    expect(applied).toEqual(prepared.previewDocument);
    expect(prepared.previewDocument).not.toBe(document);
    expect(prepared.previewDocument.nodes[text.id]).not.toBe(
      document.nodes[text.id],
    );
    expectDeepFrozen(prepared);

    input.label = "Provider mutation";
    (input.actions[0] as { content: string }).content = "Provider mutation";
    expect(prepared.proposal.label).toBe("Apply all safe changes");
    expect(prepared.previewDocument.nodes[text.id]).toMatchObject({
      content: "Northstar",
    });
  });

  it("applies actions against prior working results and rejects a later no-op", () => {
    const document = createInitialDocument();
    const text = textNode(document);
    const before = structuredClone(document);
    const result = prepareDesignMateProposal(
      document,
      proposal([
        {
          type: "set-text-content",
          nodeId: text.id,
          content: "Northstar",
        },
        {
          type: "set-text-content",
          nodeId: text.id,
          content: "Northstar",
        },
      ]),
      { generation: 0, revision: 0 },
    );

    expectFailure(result);
    if (!result.ok) {
      expect(result.error).toMatchObject({ code: "no-op", actionIndex: 1 });
    }
    expect(document).toEqual(before);

    const netNoOp = prepareDesignMateProposal(
      document,
      proposal([
        {
          type: "set-text-content",
          nodeId: text.id,
          content: "Northstar",
        },
        {
          type: "set-text-content",
          nodeId: text.id,
          content: text.content,
        },
      ]),
      { generation: 0, revision: 0 },
    );
    expectFailure(netNoOp);
    if (!netNoOp.ok) {
      expect(netNoOp.error.code).toBe("no-op");
    }
  });

  it("positions sequential variants without overlap and keeps them inactive", () => {
    const document = createInitialDocument();
    const source = document.artboards[0]!;
    const prepared = getPrepared(
      prepareDesignMateProposal(
        document,
        proposal([
          {
            type: "create-logo-variant",
            sourceArtboardId: source.id,
            purpose: "icon",
          },
          {
            type: "create-logo-variant",
            sourceArtboardId: source.id,
            purpose: "wordmark",
          },
        ]),
        { generation: 0, revision: 0 },
      ),
    );
    const [iconCommand, wordmarkCommand] = prepared.command.commands;
    expect(iconCommand?.type).toBe("add-artboard");
    expect(wordmarkCommand?.type).toBe("add-artboard");
    if (
      iconCommand?.type !== "add-artboard" ||
      wordmarkCommand?.type !== "add-artboard"
    ) {
      throw new Error("Expected add-artboard commands.");
    }

    expect(iconCommand.activate).toBe(false);
    expect(wordmarkCommand.activate).toBe(false);
    expect(iconCommand.artboard.x).toBe(
      source.x + source.width + ARTBOARD_GAP,
    );
    expect(wordmarkCommand.artboard.x).toBe(
      iconCommand.artboard.x + iconCommand.artboard.width + ARTBOARD_GAP,
    );
    expect(prepared.previewDocument.activeArtboardId).toBe(
      document.activeArtboardId,
    );
  });

  it("fails closed for missing, locked, hidden, inherited-restricted, and wrong-type nodes", () => {
    const base = createInitialDocument();
    const text = textNode(base);
    const path = pathNode(base);

    expectFailure(
      prepareDesignMateProposal(
        base,
        proposal([
          {
            type: "set-text-content",
            nodeId: "missing-node",
            content: "Northstar",
          },
        ]),
        { generation: 0, revision: 0 },
      ),
    );

    const locked = structuredClone(base);
    locked.nodes[text.id]!.locked = true;
    expectFailure(
      prepareDesignMateProposal(
        locked,
        proposal([
          {
            type: "set-text-content",
            nodeId: text.id,
            content: "Northstar",
          },
        ]),
        { generation: 0, revision: 0 },
      ),
    );

    const hidden = structuredClone(base);
    hidden.nodes[text.id]!.visible = false;
    expectFailure(
      prepareDesignMateProposal(
        hidden,
        proposal([
          {
            type: "set-text-content",
            nodeId: text.id,
            content: "Northstar",
          },
        ]),
        { generation: 0, revision: 0 },
      ),
    );

    const inheritedLocked = structuredClone(base);
    const artboard = inheritedLocked.artboards[0]!;
    const group = createGroup([text.id]);
    group.locked = true;
    inheritedLocked.nodes[group.id] = group;
    artboard.nodeIds = [
      ...artboard.nodeIds.filter((nodeId) => nodeId !== text.id),
      group.id,
    ];
    expectFailure(
      prepareDesignMateProposal(
        inheritedLocked,
        proposal([
          {
            type: "set-letter-spacing",
            nodeId: text.id,
            letterSpacing: 3,
          },
        ]),
        { generation: 0, revision: 0 },
      ),
    );

    const inheritedHidden = structuredClone(base);
    const hiddenGroup = createGroup([text.id]);
    hiddenGroup.visible = false;
    inheritedHidden.nodes[hiddenGroup.id] = hiddenGroup;
    inheritedHidden.artboards[0]!.nodeIds = [
      ...inheritedHidden.artboards[0]!.nodeIds.filter(
        (nodeId) => nodeId !== text.id,
      ),
      hiddenGroup.id,
    ];
    expectFailure(
      prepareDesignMateProposal(
        inheritedHidden,
        proposal([
          {
            type: "set-text-content",
            nodeId: text.id,
            content: "Northstar",
          },
        ]),
        { generation: 0, revision: 0 },
      ),
    );

    expectFailure(
      prepareDesignMateProposal(
        base,
        proposal([
          {
            type: "set-text-content",
            nodeId: path.id,
            content: "Northstar",
          },
        ]),
        { generation: 0, revision: 0 },
      ),
    );
  });

  it("rejects unchanged values and fills that are groups or gradients", () => {
    const document = createInitialDocument();
    const text = textNode(document);
    const path = pathNode(document);

    for (const action of [
      {
        type: "set-text-content" as const,
        nodeId: text.id,
        content: text.content,
      },
      {
        type: "set-letter-spacing" as const,
        nodeId: text.id,
        letterSpacing: text.letterSpacing,
      },
      {
        type: "set-fill-color" as const,
        nodeId: path.id,
        color: path.fill.type === "solid" ? path.fill.color.toUpperCase() : "#fff",
      },
    ]) {
      expectFailure(
        prepareDesignMateProposal(document, proposal([action]), {
          generation: 0,
          revision: 0,
        }),
      );
    }

    const gradient = structuredClone(document);
    gradient.nodes[path.id]!.fill = {
      type: "linear-gradient",
      angle: 0,
      stops: [
        { offset: 0, color: "#ffffff" },
        { offset: 1, color: "#000000" },
      ],
    };
    expectFailure(
      prepareDesignMateProposal(
        gradient,
        proposal([
          { type: "set-fill-color", nodeId: path.id, color: "#123456" },
        ]),
        { generation: 0, revision: 0 },
      ),
    );

    const grouped = structuredClone(document);
    const group = createGroup([path.id]);
    grouped.nodes[group.id] = group;
    grouped.artboards[0]!.nodeIds = [
      ...grouped.artboards[0]!.nodeIds.filter((nodeId) => nodeId !== path.id),
      group.id,
    ];
    expectFailure(
      prepareDesignMateProposal(
        grouped,
        proposal([
          { type: "set-fill-color", nodeId: group.id, color: "#123456" },
        ]),
        { generation: 0, revision: 0 },
      ),
    );
  });

  it("guards missing, empty, duplicate-purpose, and over-limit variants", () => {
    const document = createInitialDocument();
    const source = document.artboards[0]!;
    const makeVariant = (
      sourceArtboardId: string,
    ): DesignMateProposal =>
      proposal([
        {
          type: "create-logo-variant",
          sourceArtboardId,
          purpose: "icon",
        },
      ]);

    expectFailure(
      prepareDesignMateProposal(document, makeVariant("missing-artboard"), {
        generation: 0,
        revision: 0,
      }),
    );

    const empty = structuredClone(document);
    empty.artboards[0]!.nodeIds = [];
    expectFailure(
      prepareDesignMateProposal(empty, makeVariant(source.id), {
        generation: 0,
        revision: 0,
      }),
    );

    const duplicate = structuredClone(document);
    duplicate.artboards.push(
      createArtboard("icon", {
        name: "Existing icon",
        nodeIds: [],
      }),
    );
    expectFailure(
      prepareDesignMateProposal(duplicate, makeVariant(source.id), {
        generation: 0,
        revision: 0,
      }),
    );

    const atLimit = structuredClone(document);
    atLimit.artboards = Array.from({ length: 64 }, (_, index) => ({
      ...source,
      id: `artboard-limit-${index}`,
      purpose: "primary" as const,
      nodeIds: index === 0 ? [...source.nodeIds] : [],
    }));
    atLimit.activeArtboardId = atLimit.artboards[0]!.id;
    expectFailure(
      prepareDesignMateProposal(
        atLimit,
        makeVariant(atLimit.activeArtboardId),
        { generation: 0, revision: 0 },
      ),
    );

    const sequentialDuplicate = prepareDesignMateProposal(
      document,
      proposal([
        {
          type: "create-logo-variant",
          sourceArtboardId: source.id,
          purpose: "icon",
        },
        {
          type: "create-logo-variant",
          sourceArtboardId: source.id,
          purpose: "icon",
        },
      ]),
      { generation: 0, revision: 0 },
    );
    expectFailure(sequentialDuplicate);
    expect(document.artboards).toHaveLength(1);
  });
});

describe("Design Mate proposal staleness", () => {
  it("compares id, generation, revision, and full content fingerprint", () => {
    const document = createInitialDocument();
    const text = textNode(document);
    const prepared = getPrepared(
      prepareDesignMateProposal(
        document,
        proposal([
          {
            type: "set-text-content",
            nodeId: text.id,
            content: "Northstar",
          },
        ]),
        { generation: 3, revision: 9 },
      ),
    );

    const equivalent = structuredClone(document);
    equivalent.nodes = Object.fromEntries(
      Object.entries(equivalent.nodes).reverse(),
    );
    expect(
      isDesignMateProposalStale(prepared, equivalent, {
        generation: 3,
        revision: 9,
      }),
    ).toBe(false);

    const differentId = structuredClone(document);
    differentId.id = "different-document";
    expect(
      isDesignMateProposalStale(prepared, differentId, {
        generation: 3,
        revision: 9,
      }),
    ).toBe(true);
    expect(
      isDesignMateProposalStale(prepared, document, {
        generation: 4,
        revision: 9,
      }),
    ).toBe(true);
    expect(
      isDesignMateProposalStale(prepared, document, {
        generation: 3,
        revision: 10,
      }),
    ).toBe(true);

    const changedContent = structuredClone(document);
    changedContent.nodes[text.id]!.x += 0.25;
    expect(
      isDesignMateProposalStale(prepared, changedContent, {
        generation: 3,
        revision: 9,
      }),
    ).toBe(true);
  });
});
