import { expect, describe, it } from "vitest";
import { ARCHETYPE_IDS } from "@openlogo/foundry";
import { buildTemplateProposals } from "./template-proposals";

describe("template proposals", () => {
  it("builds three deterministic rounds of every archetype", () => {
    const input = {
      brandName: "Studio North",
      tagline: "Made with intent",
      vibe: "minimal" as const,
      shuffleRound: 3,
    };
    const first = buildTemplateProposals(input);
    const second = buildTemplateProposals(input);

    expect(first).toHaveLength(18);
    expect(first.map((proposal) => proposal.document)).toEqual(
      second.map((proposal) => proposal.document),
    );
    for (const archetypeId of ARCHETYPE_IDS) {
      const recipes = first.filter(
        (proposal) => proposal.archetypeId === archetypeId,
      );
      expect(recipes).toHaveLength(3);
    }
    expect(first.every((proposal) => proposal.fonts.length > 0)).toBe(true);
    expect(first.every((proposal) => proposal.svg.startsWith("<svg"))).toBe(true);
    const seal = first.find(
      (proposal) => proposal.archetypeId === "circular-seal",
    );
    expect(seal?.svg).toContain("<textPath");
    expect(seal?.svg).not.toContain('side="right"');
  });

  it("covers all three banked recipes per archetype in a mixed gallery", () => {
    const proposals = buildTemplateProposals({
      brandName: "Studio North",
      tagline: "Made with intent",
      shuffleRound: 3,
    });

    for (const archetypeId of ARCHETYPE_IDS) {
      const recipes = proposals.filter(
        (proposal) => proposal.archetypeId === archetypeId,
      );
      expect(
        new Set(
          recipes.map((proposal) => proposal.document.palettes[0]?.name),
        ).size,
      ).toBe(3);
    }
  });

  it("changes card identity on shuffle without losing personalized copy", () => {
    const first = buildTemplateProposals({
      brandName: "Harbor & Pine",
      tagline: "Goods for every day",
      shuffleRound: 0,
    });
    const shuffled = buildTemplateProposals({
      brandName: "Harbor & Pine",
      tagline: "Goods for every day",
      shuffleRound: 1,
    });

    expect(shuffled.map((proposal) => proposal.key)).not.toEqual(
      first.map((proposal) => proposal.key),
    );
    expect(
      shuffled.every((proposal) =>
        Object.values(proposal.document.nodes).some(
          (node) =>
            node.type === "text" &&
            node.content.toLocaleLowerCase().includes("harbor"),
        ),
      ),
    ).toBe(true);
  });

  it("re-renders one stable card with a selected curated palette", () => {
    const input = {
      brandName: "Harbor & Pine",
      vibe: "classic" as const,
      shuffleRound: 0,
      count: 1,
    };
    const [original] = buildTemplateProposals(input);
    const alternative = original!.paletteOptions.find(
      (palette) => palette.id !== original!.paletteId,
    )!;
    const [swapped] = buildTemplateProposals({
      ...input,
      paletteOverrides: { [original!.key]: alternative.id },
    });

    expect(swapped!.key).toBe(original!.key);
    expect(swapped!.paletteId).toBe(alternative.id);
    expect(swapped!.document.artboards[0]!.background).toBe(
      alternative.paper,
    );
    expect(Object.keys(swapped!.document.nodes)).toEqual(
      Object.keys(original!.document.nodes),
    );
    expect(swapped!.svg).not.toBe(original!.svg);
  });

  it("escapes personalized copy through the existing SVG exporter", () => {
    const [proposal] = buildTemplateProposals({
      brandName: '<script>alert("x")</script>',
      shuffleRound: 0,
      count: 1,
    });

    expect(proposal?.svg).not.toContain("<script>");
    expect(proposal?.svg).toContain("&lt;script&gt;");
  });

  it("generates and renders a 24-card grid inside the phase budget", () => {
    const started = performance.now();
    const proposals = buildTemplateProposals({
      brandName: "Northstar Studio",
      tagline: "Ideas in motion",
      vibe: "classic",
      shuffleRound: 7,
      count: 24,
    });
    const elapsed = performance.now() - started;

    expect(proposals).toHaveLength(24);
    expect(elapsed).toBeLessThan(100);
  });
});
