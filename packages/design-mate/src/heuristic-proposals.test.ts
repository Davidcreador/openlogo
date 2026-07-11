import {
  analyzeLogoDocument,
  applyCommand,
  createArtboard,
  createInitialDocument,
  createText,
  LOGO_REVIEW_CONTRAST_THRESHOLD,
  logoColorContrastRatio,
} from "@openlogo/core";
import type {
  LogoDocument,
  PathNode,
  ReviewFinding,
  TextNode,
} from "@openlogo/core";
import { describe, expect, it } from "vitest";
import {
  buildHeuristicDesignMateProposals,
  isValidDesignMateProposal,
  prepareDesignMateProposal,
  type DesignMateProposal,
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

function actionableDocument(): LogoDocument {
  const document = createInitialDocument();
  document.designBrief = { brandName: "Northstar" };
  const path = pathNode(document);
  path.fill = {
    type: "solid",
    color: document.artboards[0]!.background,
  };
  path.opacity = 1;
  return document;
}

function prepare(
  document: LogoDocument,
  proposal: DesignMateProposal,
): PreparedDesignMateProposal {
  const result = prepareDesignMateProposal(document, proposal, {
    generation: 0,
    revision: 0,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.prepared;
}

function actionType(proposal: DesignMateProposal): string {
  return proposal.actions[0]!.type;
}

describe("buildHeuristicDesignMateProposals", () => {
  it("maps only clear current actions into deterministic valid raw proposals", () => {
    const document = actionableDocument();
    const before = structuredClone(document);
    const findings = analyzeLogoDocument(document).findings;

    const first = buildHeuristicDesignMateProposals(
      document,
      findings,
      "active-artboard",
    );
    const second = buildHeuristicDesignMateProposals(
      document,
      [...findings].reverse(),
      "active-artboard",
    );

    expect(first).toEqual(second);
    expect(document).toEqual(before);
    expect(first.map(actionType).sort()).toEqual([
      "align-nodes",
      "create-logo-variant",
      "create-logo-variant",
      "create-logo-variant",
      "create-logo-variant",
      "set-fill-color",
      "set-text-content",
    ]);
    expect(first.every(isValidDesignMateProposal)).toBe(true);
    expect(first.every((item) => item.id.length <= 256)).toBe(true);
    expect(new Set(first.map((item) => item.id)).size).toBe(first.length);

    const fill = first.find(
      (item) => actionType(item) === "set-fill-color",
    );
    expect(fill?.risk).toBe("medium");
    for (const item of first) {
      expect(
        prepareDesignMateProposal(document, item, {
          generation: 0,
          revision: 0,
        }).ok,
      ).toBe(true);
    }
  });

  it("resolves the factual brand mismatch on the unique largest text node", () => {
    const document = actionableDocument();
    const findings = analyzeLogoDocument(document).findings;
    const raw = buildHeuristicDesignMateProposals(
      document,
      findings,
      "active-artboard",
    ).find((item) => actionType(item) === "set-text-content");
    expect(raw).toBeDefined();
    if (!raw) {
      throw new Error("Expected a brief-alignment proposal.");
    }

    const action = raw.actions[0]!;
    expect(action).toMatchObject({
      type: "set-text-content",
      nodeId: textNode(document).id,
      content: "Northstar",
    });
    const preview = prepare(document, raw).previewDocument;
    expect(
      analyzeLogoDocument(preview).findings.some((finding) =>
        finding.id.startsWith("concept.brand-name-mismatch"),
      ),
    ).toBe(false);
  });

  it("chooses a palette or neutral fill that clears the core contrast threshold", () => {
    const document = actionableDocument();
    const target = pathNode(document);
    const findings = analyzeLogoDocument(document).findings;
    const raw = buildHeuristicDesignMateProposals(
      document,
      findings,
      "active-artboard",
    ).find((item) => actionType(item) === "set-fill-color");
    expect(raw).toBeDefined();
    if (!raw) {
      throw new Error("Expected a contrast proposal.");
    }

    const preview = prepare(document, raw).previewDocument;
    const fill = preview.nodes[target.id]!.fill;
    expect(fill.type).toBe("solid");
    if (fill.type !== "solid") {
      throw new Error("Expected a solid preview fill.");
    }
    expect(
      logoColorContrastRatio(
        fill.color,
        preview.artboards[0]!.background,
      ),
    ).toBeGreaterThanOrEqual(LOGO_REVIEW_CONTRAST_THRESHOLD);
    expect(
      analyzeLogoDocument(preview).findings.some(
        (finding) =>
          finding.category === "color" &&
          finding.nodeIds?.includes(target.id),
      ),
    ).toBe(false);
  });

  it("offers at most two deterministic contrast alternatives", () => {
    const document = actionableDocument();
    document.palettes = [
      {
        id: "palette-alternatives",
        name: "Alternatives",
        colors: ["#111111", "#222222", "#333333"],
      },
    ];
    const proposals = buildHeuristicDesignMateProposals(
      document,
      analyzeLogoDocument(document).findings,
      "active-artboard",
    ).filter((item) => actionType(item) === "set-fill-color");

    expect(proposals).toHaveLength(2);
    expect(
      proposals.map((item) =>
        item.actions[0]?.type === "set-fill-color"
          ? item.actions[0].color
          : null,
      ),
    ).toEqual(["#111111", "#222222"]);
  });

  it("fits referenced overflowing artwork inside the export artboard", () => {
    const document = actionableDocument();
    const artboard = document.artboards[0]!;
    const target = pathNode(document);
    target.x = artboard.width + 20;
    const finding = analyzeLogoDocument(document).findings.find(
      (item) =>
        item.suggestedActions.some(
          (action) => action.id === "fit-artwork-to-artboard",
        ) && item.nodeIds?.includes(target.id),
    );
    expect(finding).toBeDefined();
    if (!finding) {
      throw new Error("Expected an overflow finding.");
    }
    const raw = buildHeuristicDesignMateProposals(
      document,
      [finding],
      "active-artboard",
    )[0];
    expect(raw?.actions.some((action) => action.type === "translate-nodes")).toBe(
      true,
    );
    if (!raw) {
      throw new Error("Expected an artboard-fit proposal.");
    }
    const preview = prepare(document, raw).previewDocument;
    expect(
      analyzeLogoDocument(preview).findings.some(
        (item) =>
          item.category === "production" &&
          item.nodeIds?.includes(target.id),
      ),
    ).toBe(false);
  });

  it("creates a brief-backed editable wordmark only when visible text is absent", () => {
    const document = createInitialDocument();
    document.designBrief = { brandName: "Northstar" };
    const artboard = document.artboards[0]!;
    const textIds = artboard.nodeIds.filter(
      (nodeId) => document.nodes[nodeId]?.type === "text",
    );
    artboard.nodeIds = artboard.nodeIds.filter(
      (nodeId) => !textIds.includes(nodeId),
    );
    for (const nodeId of textIds) {
      delete document.nodes[nodeId];
    }

    const raw = buildHeuristicDesignMateProposals(
      document,
      analyzeLogoDocument(document).findings,
      "active-artboard",
    ).find((item) => actionType(item) === "create-wordmark");
    expect(raw?.actions[0]).toEqual({
      type: "create-wordmark",
      artboardId: artboard.id,
      content: "Northstar",
    });
    if (!raw) {
      throw new Error("Expected a wordmark proposal.");
    }
    const preview = prepare(document, raw).previewDocument;
    expect(
      Object.values(preview.nodes).find(
        (node) => node.type === "text" && node.content === "Northstar",
      ),
    ).toBeDefined();
  });

  it("skips ambiguous, locked, hidden, and already-resolved wordmarks", () => {
    const tied = actionableDocument();
    const originalText = textNode(tied);
    const secondText = createText({
      x: 40,
      y: 40,
      content: "Another name",
    });
    secondText.fontSize = originalText.fontSize;
    const tiedDocument = applyCommand(tied, {
      type: "insert-nodes",
      artboardId: tied.activeArtboardId,
      nodes: [secondText],
    }).document;
    const tiedProposals = buildHeuristicDesignMateProposals(
      tiedDocument,
      analyzeLogoDocument(tiedDocument).findings,
      "active-artboard",
    );
    expect(tiedProposals.some((item) => actionType(item) === "set-text-content"))
      .toBe(false);

    for (const state of ["locked", "hidden", "resolved"] as const) {
      const document = actionableDocument();
      const text = textNode(document);
      const findings = analyzeLogoDocument(document).findings;
      if (state === "locked") {
        text.locked = true;
      } else if (state === "hidden") {
        text.visible = false;
      } else {
        text.content = "Northstar";
      }
      const proposals = buildHeuristicDesignMateProposals(
        document,
        findings,
        "active-artboard",
      );
      expect(
        proposals.some((item) => actionType(item) === "set-text-content"),
      ).toBe(false);
    }
  });

  it("requires one visible unlocked solid-fill target and never edits gradients", () => {
    const gradient = actionableDocument();
    const gradientPath = pathNode(gradient);
    gradientPath.fill = {
      type: "linear-gradient",
      angle: 0,
      stops: [
        { offset: 0, color: gradient.artboards[0]!.background },
        { offset: 1, color: gradient.artboards[0]!.background },
      ],
    };
    const gradientProposals = buildHeuristicDesignMateProposals(
      gradient,
      analyzeLogoDocument(gradient).findings,
      "active-artboard",
    );
    expect(
      gradientProposals.some((item) => actionType(item) === "set-fill-color"),
    ).toBe(false);

    const ambiguous = actionableDocument();
    const first = pathNode(ambiguous);
    const second = textNode(ambiguous);
    second.fill = {
      type: "solid",
      color: ambiguous.artboards[0]!.background,
    };
    const contrastFinding = analyzeLogoDocument(ambiguous).findings.find(
      (finding) =>
        finding.suggestedActions.some(
          (action) => action.id === "increase-color-contrast",
        ) && finding.nodeIds?.includes(first.id),
    )!;
    const ambiguousFinding: ReviewFinding = {
      ...contrastFinding,
      nodeIds: [first.id, second.id],
    };
    expect(
      buildHeuristicDesignMateProposals(
        ambiguous,
        [ambiguousFinding],
        "active-artboard",
      ),
    ).toEqual([]);
  });

  it("creates full variants only outside selection scope and guards source state", () => {
    const document = actionableDocument();
    const findings = analyzeLogoDocument(document).findings;
    const activeProposals = buildHeuristicDesignMateProposals(
      document,
      findings,
      "active-artboard",
    ).filter((item) => actionType(item) === "create-logo-variant");
    expect(activeProposals).toHaveLength(4);
    expect(
      activeProposals.every(
        (item) =>
          item.actions[0]?.type === "create-logo-variant" &&
          item.actions[0].sourceArtboardId === document.artboards[0]!.id,
      ),
    ).toBe(true);

    const selectionProposals = buildHeuristicDesignMateProposals(
      document,
      findings,
      "selection",
    );
    expect(
      selectionProposals.some(
        (item) => actionType(item) === "create-logo-variant",
      ),
    ).toBe(false);

    const withIcon = structuredClone(document);
    withIcon.artboards.push(createArtboard("icon", { nodeIds: [] }));
    expect(
      buildHeuristicDesignMateProposals(
        withIcon,
        findings,
        "active-artboard",
      ).some(
        (item) =>
          item.actions[0]?.type === "create-logo-variant" &&
          item.actions[0].purpose === "icon",
      ),
    ).toBe(false);

    const empty = structuredClone(document);
    empty.artboards[0]!.nodeIds = [];
    expect(
      buildHeuristicDesignMateProposals(
        empty,
        findings,
        "active-artboard",
      ).some((item) => actionType(item) === "create-logo-variant"),
    ).toBe(false);

    const fallback = structuredClone(document);
    fallback.artboards[0]!.purpose = "horizontal";
    const fallbackProposal = buildHeuristicDesignMateProposals(
      fallback,
      analyzeLogoDocument(fallback).findings,
      "active-artboard",
    ).find((item) => actionType(item) === "create-logo-variant");
    expect(fallbackProposal?.actions[0]).toMatchObject({
      type: "create-logo-variant",
      sourceArtboardId: fallback.activeArtboardId,
    });
  });

  it("previews conservative tracking and one small detail but defers open-ended judgment", () => {
    const document = actionableDocument();
    const text = textNode(document);
    const path = pathNode(document);
    text.letterSpacing = 0;
    path.width = 8;
    const analyzed = analyzeLogoDocument(document).findings;
    const template = analyzed[0]!;
    const addWordmark: ReviewFinding = {
      ...template,
      id: "synthetic-add-wordmark",
      category: "typography",
      kind: "objective",
      suggestedActions: [{ id: "add-wordmark", label: "Add a wordmark" }],
    };
    const judgment: ReviewFinding = {
      ...template,
      id: "synthetic-judgment",
      category: "color",
      kind: "judgment",
      suggestedActions: [
        { id: "increase-color-contrast", label: "Guess a better color" },
      ],
    };
    const findings = [...analyzed, addWordmark, judgment];
    const actionableIds = new Set(
      findings
        .filter((finding) =>
          finding.suggestedActions.some((action) =>
            [
              "adjust-optical-tracking",
              "simplify-small-details",
            ].includes(action.id),
          ),
        )
        .map((finding) => finding.id),
    );
    const proposals = buildHeuristicDesignMateProposals(
      document,
      findings,
      "active-artboard",
    );

    expect(
      proposals.some((item) => actionType(item) === "set-letter-spacing"),
    ).toBe(true);
    expect(
      proposals.some((item) =>
        item.sourceFindingIds?.some((id) => actionableIds.has(id)),
      ),
    ).toBe(true);
    expect(proposals.some((item) => actionType(item) === "scale-nodes")).toBe(
      true,
    );
    expect(
      proposals.some((item) =>
        item.sourceFindingIds?.includes("synthetic-add-wordmark"),
      ),
    ).toBe(false);
    expect(
      proposals.some((item) =>
        item.sourceFindingIds?.includes("synthetic-judgment"),
      ),
    ).toBe(false);
  });
});
