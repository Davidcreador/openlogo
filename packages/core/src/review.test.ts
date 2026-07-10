import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import {
  createArtboard,
  createInitialDocument,
  createRectangle,
} from "./factory";
import { getActiveArtboard } from "./queries";
import { analyzeLogoDocument } from "./review";
import type { LogoDocument } from "./types";

function createReviewDocument(): {
  document: LogoDocument;
  activeTinyId: string;
  iconTinyId: string;
  iconArtboardId: string;
} {
  const initial = createInitialDocument();
  const active = getActiveArtboard(initial);
  const activeTinyId = active.nodeIds[0]!;
  const activeTiny = initial.nodes[activeTinyId]!;
  let document: LogoDocument = {
    ...initial,
    nodes: {
      ...initial.nodes,
      [activeTinyId]: {
        ...activeTiny,
        name: "Active tiny detail",
        width: 8,
        height: 12,
        opacity: 1,
        fill: { type: "solid", color: "#ffffff" },
      },
    },
  };

  const iconTiny = createRectangle({ x: 20, y: 20, fill: "#ffffff" });
  iconTiny.name = "Icon tiny detail";
  iconTiny.width = 10;
  iconTiny.height = 10;
  const iconArtboard = createArtboard("icon", {
    name: "Icon",
    x: 900,
    background: "#ffffff",
    nodeIds: [iconTiny.id],
  });
  document = applyCommand(document, {
    type: "add-artboard",
    artboard: iconArtboard,
    nodes: [iconTiny],
    activate: false,
  }).document;

  return {
    document,
    activeTinyId,
    iconTinyId: iconTiny.id,
    iconArtboardId: iconArtboard.id,
  };
}

describe("analyzeLogoDocument", () => {
  it("returns stable ids and structured evidence/actions", () => {
    const { document } = createReviewDocument();
    const first = analyzeLogoDocument(document);
    const cloned = JSON.parse(JSON.stringify(document)) as LogoDocument;
    const second = analyzeLogoDocument(cloned);

    expect(second).toEqual(first);
    const ids = first.findings.map((finding) => finding.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const finding of first.findings) {
      expect(finding.id.length).toBeGreaterThan(0);
      expect([
        "concept",
        "composition",
        "typography",
        "geometry",
        "color",
        "scalability",
        "variants",
        "production",
      ]).toContain(finding.category);
      expect(["objective", "judgment"]).toContain(finding.kind);
      expect(finding.evidence.length).toBeGreaterThan(0);
      expect(finding.suggestedActions.length).toBeGreaterThan(0);
      expect(finding.title).not.toBe("");
      expect(finding.detail).not.toBe("");
      expect(finding.action).not.toBe("");
    }
  });

  it("defaults to the active artboard and attaches accurate references", () => {
    const { document, activeTinyId, iconArtboardId } = createReviewDocument();
    const activeArtboardId = document.activeArtboardId;
    const review = analyzeLogoDocument(document);

    expect(
      review.findings
        .filter((finding) => finding.artboardId !== undefined)
        .every((finding) => finding.artboardId === activeArtboardId),
    ).toBe(true);
    expect(
      review.findings.some(
        (finding) => finding.artboardId === iconArtboardId,
      ),
    ).toBe(false);

    const contrast = review.findings.find(
      (finding) =>
        finding.category === "color" &&
        finding.nodeIds?.includes(activeTinyId),
    );
    expect(contrast).toMatchObject({
      artboardId: activeArtboardId,
      nodeIds: [activeTinyId],
      kind: "objective",
    });
    expect(
      contrast?.evidence.find((item) => item.label === "Contrast ratio")?.value,
    ).toBeTypeOf("number");

    const variant = review.findings.find(
      (finding) => finding.id === "variants.missing-wordmark",
    );
    expect(variant).toBeDefined();
    expect(variant).not.toHaveProperty("nodeIds");
    expect(variant).not.toHaveProperty("artboardId");
  });

  it("reviews only selected leaves and falls back for an invalid selection", () => {
    const { document, activeTinyId, iconTinyId } = createReviewDocument();
    const selection = analyzeLogoDocument(document, {
      scope: "selection",
      selectionIds: [activeTinyId],
    });

    expect(selection.findings.length).toBeGreaterThan(0);
    expect(
      selection.findings.every(
        (finding) =>
          finding.category !== "variants" &&
          finding.artboardId === document.activeArtboardId &&
          finding.nodeIds?.every((nodeId) => nodeId === activeTinyId) === true,
      ),
    ).toBe(true);
    expect(
      selection.findings.some((finding) =>
        finding.nodeIds?.includes(iconTinyId),
      ),
    ).toBe(false);

    expect(
      analyzeLogoDocument(document, {
        scope: "selection",
        selectionIds: ["missing-node"],
      }),
    ).toEqual(analyzeLogoDocument(document));
  });

  it("reviews every artboard in document scope", () => {
    const { document, activeTinyId, iconTinyId, iconArtboardId } =
      createReviewDocument();
    const review = analyzeLogoDocument(document, { scope: "document" });
    const tinyFindings = review.findings.filter(
      (finding) => finding.id.startsWith("scalability.tiny-details:"),
    );

    expect(tinyFindings).toHaveLength(2);
    expect(tinyFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artboardId: document.activeArtboardId,
          nodeIds: [activeTinyId],
        }),
        expect.objectContaining({
          artboardId: iconArtboardId,
          nodeIds: [iconTinyId],
        }),
      ]),
    );
    expect(
      review.findings.some(
        (finding) => finding.id === "variants.missing-wordmark",
      ),
    ).toBe(true);
  });

  it("uses an explicit brand brief for factual wordmark alignment", () => {
    const document = createInitialDocument();
    document.designBrief = {
      brandName: "Northstar",
      attributes: ["precise", "dependable"],
    };

    const mismatched = analyzeLogoDocument(document);
    expect(mismatched.summary).toContain("For Northstar");
    expect(
      mismatched.findings.find(
        (finding) =>
          finding.id ===
          `concept.brand-name-mismatch:${document.activeArtboardId}`,
      ),
    ).toMatchObject({
      category: "concept",
      kind: "objective",
    });

    const text = Object.values(document.nodes).find(
      (node) => node.type === "text",
    );
    expect(text).toBeDefined();
    if (text?.type === "text") {
      text.content = "Northstar";
    }
    expect(
      analyzeLogoDocument(document).findings.some((finding) =>
        finding.id.startsWith("concept.brand-name-mismatch"),
      ),
    ).toBe(false);
  });
});
