import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDocument, type TextNode } from "@openlogo/core";
import { describe, expect, it } from "vitest";
import { ARCHETYPES } from "./archetypes";
import { generate } from "./generate";
import { FONT_PAIRINGS, MOTIFS, PALETTES } from "./ingredients";
import { createPrng } from "./prng";
import { RECIPE_BANK } from "./recipes";
import { renderShowcaseSvg } from "./svg-fixture";
import { ARCHETYPE_IDS, VIBES } from "./types";

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((channel) =>
      channel <= 0.03928
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort(
    (left, right) => right - left,
  );
  return (lighter! + 0.05) / (darker! + 0.05);
}

const PATH_COMMAND_ARITY: Record<string, number> = {
  A: 7,
  C: 6,
  H: 1,
  L: 2,
  M: 2,
  Q: 4,
  S: 4,
  T: 2,
  V: 1,
  Z: 0,
};

function validatePathData(d: string): void {
  const tokenPattern = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;
  const tokens = [...d.matchAll(tokenPattern)];
  if (tokens[0]?.[0].toUpperCase() !== "M") {
    throw new Error("Path data must start with a move command");
  }
  let cursor = 0;
  let command = "";
  let parameterCount = 0;

  const finishCommand = () => {
    if (!command) {
      return;
    }
    const arity = PATH_COMMAND_ARITY[command.toUpperCase()];
    if (arity === undefined) {
      throw new Error(`Unsupported path command: ${command}`);
    }
    if (arity > 0 && (parameterCount === 0 || parameterCount % arity !== 0)) {
      throw new Error(
        `Path command ${command} has ${parameterCount} parameters; expected groups of ${arity}`,
      );
    }
  };

  for (const match of tokens) {
    if (!/^[\s,]*$/.test(d.slice(cursor, match.index))) {
      throw new Error(`Invalid path data near: ${d.slice(cursor)}`);
    }
    cursor = match.index! + match[0].length;

    if (/^[a-zA-Z]$/.test(match[0])) {
      finishCommand();
      command = match[0];
      parameterCount = 0;
    } else {
      if (!command || command.toUpperCase() === "Z") {
        throw new Error(`Path number has no command: ${match[0]}`);
      }
      parameterCount += 1;
    }
  }

  if (!/^[\s,]*$/.test(d.slice(cursor))) {
    throw new Error(`Invalid path data near: ${d.slice(cursor)}`);
  }
  finishCommand();
}

describe("foundry generation", () => {
  it("pins the mulberry32 sequence", () => {
    const random = createPrng(42);
    expect(Array.from({ length: 5 }, () => random.next())).toEqual([
      0.6011037519201636,
      0.44829055899754167,
      0.8524657934904099,
      0.6697340414393693,
      0.17481389874592423,
    ]);
  });

  it("returns identical output for identical input and pins a document fixture", async () => {
    const input = {
      brandName: "Northstar Studio",
      tagline: "Ideas in motion",
      archetypeId: "wordmark" as const,
      vibe: "minimal" as const,
      seed: 20260713,
    };
    const first = generate(input);
    const second = generate(input);

    expect(second).toEqual(first);
    await expect(`${JSON.stringify(first, null, 2)}\n`).toMatchFileSnapshot(
      fixturePath("wordmark-document.json"),
    );
  });

  it("swaps a curated palette without perturbing seeded structure", () => {
    const input = {
      brandName: "Northstar Studio",
      tagline: "Ideas in motion",
      archetypeId: "lockup" as const,
      vibe: "minimal" as const,
      seed: 8821,
    };
    const original = generate(input);
    const swapped = generate({ ...input, paletteId: "chalk-cobalt" });

    expect(swapped.artboards[0]?.background).toBe("#F1F3F8");
    expect(swapped.palettes[0]?.name).toBe("Chalk Cobalt");
    expect(Object.keys(swapped.nodes)).toEqual(Object.keys(original.nodes));
    expect(
      Object.values(swapped.nodes).map(({ fill: _fill, stroke: _stroke, ...node }) => node),
    ).toEqual(
      Object.values(original.nodes).map(({ fill: _fill, stroke: _stroke, ...node }) => node),
    );
    expect(() => generate({ ...input, paletteId: "missing" })).toThrow(
      "Unknown palette: missing",
    );
  });

  it("produces core-valid documents across every archetype and vibe", () => {
    for (const archetypeId of ARCHETYPE_IDS) {
      for (const [index, vibe] of VIBES.entries()) {
        const document = generate({
          brandName: "Open Logo Works",
          tagline: "Made to evolve",
          archetypeId,
          vibe,
          seed: 700 + index,
        });
        const parsed = parseDocument(JSON.parse(JSON.stringify(document)));
        expect(parsed).toEqual(document);
        expect(new Set(Object.keys(document.nodes)).size).toBe(Object.keys(document.nodes).length);
        expect(Object.keys(document.nodes).every((id) => id.includes((700 + index).toString(36)))).toBe(true);
      }
    }
  });

  it("emits valid path data across every archetype, vibe, and seed", () => {
    for (const archetypeId of ARCHETYPE_IDS) {
      for (const vibe of VIBES) {
        for (let seed = 0; seed < 24; seed += 1) {
          const document = generate({
            brandName: "Open Logo Works",
            tagline: "Made to evolve",
            archetypeId,
            vibe,
            seed,
          });
          for (const node of Object.values(document.nodes)) {
            if (node.type === "path") {
              expect(
                () => validatePathData(node.d),
                `${archetypeId}:${vibe}:${seed}:${node.name}`,
              ).not.toThrow();
            }
          }
        }
      }
    }
  });

  it("defines valid path data for every curated motif", () => {
    for (const motif of MOTIFS) {
      expect(() => validatePathData(motif.d), motif.id).not.toThrow();
    }
  });

  it("creates well-formed text-on-path attachments", () => {
    for (let seed = 0; seed < 24; seed += 1) {
      const document = generate({
        brandName: "Arc & Anchor",
        tagline: "Est. 2026",
        archetypeId: "circular-seal",
        seed,
      });
      const attached = Object.values(document.nodes).filter(
        (node): node is TextNode => node.type === "text" && node.onPath !== undefined,
      );
      expect(attached).toHaveLength(2);
      expect(
        Object.values(document.nodes).filter(
          (node) => node.name === "Arc separator",
        ),
      ).toHaveLength(2);
      for (const text of attached) {
        const path = document.nodes[text.onPath!.pathId];
        expect(path?.type).toBe("path");
        expect(document.artboards[0]!.nodeIds).toContain(text.id);
        expect(document.artboards[0]!.nodeIds).toContain(path!.id);
        expect(Number.isFinite(text.onPath!.startOffset)).toBe(true);
        expect(text.onPath!.startOffset).toBeGreaterThanOrEqual(0);
      }
      expect(parseDocument(document)).toEqual(document);
    }
  });

  it("fits complete seal arcs or falls back to the center monogram", () => {
    const representativeVibes = ["classic", "minimal", "retro"] as const;
    for (const brandName of ["Aria", "Northwind", "Golden Hour Coffee Co"]) {
      for (const vibe of representativeVibes) {
        const document = generate({
          brandName,
          tagline: "Coffee Roasters",
          archetypeId: "circular-seal",
          vibe,
          seed: 914,
        });
        const brandArc = Object.values(document.nodes).find(
          (node): node is TextNode =>
            node.type === "text" && node.name === "Brand name on arc",
        );
        expect(brandArc?.content).toBe(brandName.toLocaleUpperCase());
        expect(brandArc?.fontSize).toBeGreaterThanOrEqual(14);
        expect(brandArc?.onPath?.startOffset).toBeGreaterThanOrEqual(19);
      }
    }

    const modernLongName = generate({
      brandName: "Worldwide Worldwide Worldwide Worldwide Worldwide",
      tagline: "Worldwide Worldwide Worldwide Worldwide Worldwide",
      archetypeId: "circular-seal",
      vibe: "minimal",
      seed: 914,
    });
    expect(
      Object.values(modernLongName.nodes).find(
        (node) => node.name === "Brand name on arc",
      ),
    ).toBeUndefined();
    expect(
      Object.values(modernLongName.nodes).find(
        (node) => node.name === "Tagline on arc",
      ),
    ).toBeUndefined();
    expect(
      Object.values(modernLongName.nodes).find(
        (node): node is TextNode =>
          node.type === "text" && node.name === "Center monogram",
      )?.content,
    ).toBe("WW");
  });

  it("keeps representative plain text within conservative node boxes", () => {
    for (const archetypeId of ARCHETYPE_IDS) {
      const document = generate({
        brandName: "Northstar Studio",
        tagline: "Ideas in motion",
        archetypeId,
        vibe: "classic",
        seed: 441,
      });
      for (const node of Object.values(document.nodes)) {
        if (node.type !== "text" || node.onPath) {
          continue;
        }
        const longestLine = node.content
          .split("\n")
          .reduce((longest, line) => line.length > longest.length ? line : longest);
        const glyphs = Array.from(longestLine).length;
        const estimatedWidth = glyphs * node.fontSize * 0.58
          + Math.max(0, glyphs - 1) * Math.max(0, node.letterSpacing);
        expect(estimatedWidth, `${archetypeId}:${node.name}`).toBeLessThanOrEqual(
          node.width * 1.12,
        );
      }
    }
  });

  it("extracts word initials instead of the first two letters", () => {
    const markFor = (brandName: string): string => {
      const document = generate({
        brandName,
        archetypeId: "monogram",
        vibe: "minimal",
        seed: 19,
      });
      const node = Object.values(document.nodes).find(
        (candidate): candidate is TextNode =>
          candidate.type === "text" && candidate.name === "Initials",
      );
      return node?.content ?? "";
    };

    expect(markFor("Northwind")).toBe("N");
    expect(markFor("Northwind Coffee")).toBe("NC");
    expect(markFor("Golden Hour Coffee Co")).toBe("GH");
  });

  it("enforces composition safety and typography hierarchy", () => {
    for (const archetypeId of ARCHETYPE_IDS) {
      for (const vibe of VIBES) {
        const document = generate({
          brandName: "Golden Hour Coffee Co",
          tagline: "Coffee Roasters",
          archetypeId,
          vibe,
          seed: 914,
        });
        const artboard = document.artboards[0]!;
        const marginX = artboard.width * 0.06;
        const marginY = artboard.height * 0.06;
        const visible = Object.values(document.nodes).filter((node) => node.visible);

        for (const node of visible) {
          const strokeInset = node.stroke?.width ? node.stroke.width / 2 : 0;
          expect(node.x - strokeInset, `${archetypeId}:${node.name}:left`).toBeGreaterThanOrEqual(marginX - 0.01);
          expect(node.y - strokeInset, `${archetypeId}:${node.name}:top`).toBeGreaterThanOrEqual(marginY - 0.01);
          expect(node.x + node.width + strokeInset, `${archetypeId}:${node.name}:right`).toBeLessThanOrEqual(artboard.width - marginX + 0.01);
          expect(node.y + node.height + strokeInset, `${archetypeId}:${node.name}:bottom`).toBeLessThanOrEqual(artboard.height - marginY + 0.01);
        }

        const text = visible.filter(
          (node): node is TextNode => node.type === "text",
        );
        expect(new Set(text.map((node) => node.fontSize)).size).toBeLessThanOrEqual(2);
        const largestSize = Math.max(...text.map((node) => node.fontSize));
        for (const node of text) {
          if (node.name.includes("Tagline")) {
            expect(node.fontSize).toBeLessThanOrEqual(largestSize * 0.4);
          }
          if (
            /\p{L}/u.test(node.content) &&
            node.content === node.content.toLocaleUpperCase()
          ) {
            expect(node.letterSpacing / node.fontSize).toBeGreaterThanOrEqual(0.06);
            expect(node.letterSpacing / node.fontSize).toBeLessThanOrEqual(0.16);
          }
        }

        const [paper] = document.palettes[0]!.colors;
        const inkColors = new Set<string>();
        const strokeWidths = new Set<number>();
        for (const node of visible) {
          if (node.fill.type === "solid" && node.fill.color !== paper) {
            inkColors.add(node.fill.color);
          }
          if (node.stroke) {
            inkColors.add(node.stroke.color);
            strokeWidths.add(node.stroke.width);
          }
        }
        expect(inkColors.size).toBeLessThanOrEqual(2);
        expect(strokeWidths.size).toBeLessThanOrEqual(1);
      }
    }
  });

  it("keeps cartouche taglines inside the ribbon center panel", () => {
    for (const vibe of VIBES) {
      const document = generate({
        brandName: "Golden Hour Coffee Co",
        tagline: "Coffee Roasters",
        archetypeId: "cartouche",
        vibe,
        seed: 37,
      });
      const banner = Object.values(document.nodes).find(
        (node) => node.name === "Tagline ribbon",
      )!;
      const tagline = Object.values(document.nodes).find(
        (node) => node.name === "Tagline",
      )!;
      expect(tagline.x).toBeGreaterThanOrEqual(banner.x + banner.width * 0.24);
      expect(tagline.x + tagline.width).toBeLessThanOrEqual(
        banner.x + banner.width * 0.76,
      );
    }
  });

  it("references only actual editor builtin font families", () => {
    const catalogSource = readFileSync(
      new URL("../../editor/src/lib/font-catalog.ts", import.meta.url),
      "utf8",
    );
    const builtinBlock = catalogSource.match(
      /export const BUILTIN_FONTS:[\s\S]*?\n\];/,
    )?.[0];
    expect(builtinBlock).toBeDefined();
    const builtinFamilies = new Set(
      [...(builtinBlock ?? "").matchAll(/name: "([^"]+)"/g)].map((match) => match[1]),
    );
    expect(builtinFamilies.size).toBeGreaterThan(0);

    for (const pairing of FONT_PAIRINGS) {
      expect(builtinFamilies.has(pairing.display.family), pairing.id).toBe(true);
      expect(builtinFamilies.has(pairing.supporting.family), pairing.id).toBe(true);
    }
  });

  it("keeps curated tables complete and internally consistent", () => {
    expect(ARCHETYPES).toHaveLength(6);
    expect(ARCHETYPES.every((item) => item.parameterRanges.length >= 3)).toBe(true);
    expect(PALETTES).toHaveLength(12);
    expect(RECIPE_BANK).toHaveLength(18);
    expect(MOTIFS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(FONT_PAIRINGS.map((item) => item.id)).size).toBe(FONT_PAIRINGS.length);
    expect(new Set(PALETTES.map((item) => item.id)).size).toBe(PALETTES.length);
    expect(new Set(MOTIFS.map((item) => item.id)).size).toBe(MOTIFS.length);
    expect(new Set(RECIPE_BANK.map((item) => item.id)).size).toBe(RECIPE_BANK.length);
    expect(PALETTES.some((palette) => palette.id === "black-acid")).toBe(false);
    for (const palette of PALETTES) {
      expect(contrast(palette.paper, palette.ink), `${palette.id}:ink`).toBeGreaterThanOrEqual(10);
      expect(contrast(palette.paper, palette.accent), `${palette.id}:accent`).toBeGreaterThanOrEqual(3.4);
    }
    for (const archetypeId of ARCHETYPE_IDS) {
      const recipes = RECIPE_BANK.filter(
        (recipe) => recipe.archetypeId === archetypeId,
      );
      expect(recipes).toHaveLength(3);
      for (const vibe of VIBES) {
        expect(
          recipes.some((recipe) =>
            (recipe.vibes as readonly (typeof VIBES)[number][]).includes(vibe),
          ),
        ).toBe(true);
      }
    }
    for (const recipe of RECIPE_BANK) {
      expect(FONT_PAIRINGS.some((item) => item.id === recipe.fontPairingId)).toBe(true);
      expect(PALETTES.some((item) => item.id === recipe.paletteId)).toBe(true);
      expect(recipe.motifIds.every((id) => MOTIFS.some((item) => item.id === id))).toBe(true);
    }
    for (const vibe of VIBES) {
      expect(FONT_PAIRINGS.some((item) => item.vibes.includes(vibe))).toBe(true);
      expect(PALETTES.some((item) => item.vibes.includes(vibe))).toBe(true);
      expect(MOTIFS.some((item) => item.vibes.includes(vibe))).toBe(true);
    }
  });

  it("pins a DOM-free SVG showcase for visual review", async () => {
    const documents = ARCHETYPE_IDS.map((archetypeId, index) =>
      generate({
        brandName: "Northstar Studio",
        tagline: "Ideas in motion",
        archetypeId,
        vibe: VIBES[index]!,
        seed: 1100 + index,
      }),
    );
    await expect(renderShowcaseSvg(documents)).toMatchFileSnapshot(
      fixturePath("archetype-showcase.svg"),
    );
  });
});
