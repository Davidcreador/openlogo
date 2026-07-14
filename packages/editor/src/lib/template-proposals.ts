import type { LogoDocument } from "@openlogo/core";
import {
  ARCHETYPES,
  ARCHETYPE_IDS,
  PALETTES,
  RECIPE_BANK,
  createPrng,
  generate,
  type ArchetypeId,
  type FoundryPalette,
  type Vibe,
} from "@openlogo/foundry";
import { documentToSvg } from "./export";
import {
  collectDocumentFontFaces,
  type SvgFontRequest,
} from "./svg-fonts";

const BASE_SEED = 0x4f50454e;

export type TemplateProposal = {
  key: string;
  archetypeId: ArchetypeId;
  archetypeLabel: string;
  seed: number;
  paletteId: string;
  paletteOptions: readonly FoundryPalette[];
  document: LogoDocument;
  svg: string;
  fonts: SvgFontRequest[];
};

export type TemplateProposalInput = {
  brandName: string;
  tagline?: string;
  vibe?: Vibe;
  shuffleRound: number;
  count?: number;
  paletteOverrides?: Readonly<Record<string, string>>;
};

function seedFor(
  round: number,
  index: number,
  archetypeId: ArchetypeId,
): number {
  const base = (
    BASE_SEED
    + Math.imul(round + 1, 0x9e3779b9)
    + Math.imul(index + 1, 0x85ebca6b)
  ) >>> 0;
  const recipeCount = RECIPE_BANK.filter(
    (recipe) => recipe.archetypeId === archetypeId,
  ).length;
  const targetSlot = (
    Math.floor(index / ARCHETYPE_IDS.length) + round
  ) % recipeCount;
  for (let offset = 0; offset < 32; offset += 1) {
    const candidate = (base + offset) >>> 0;
    if (createPrng(candidate).int(0, recipeCount - 1) === targetSlot) {
      return candidate;
    }
  }
  return base;
}

const labels = new Map(
  ARCHETYPES.map((archetype) => [archetype.id, archetype.label]),
);

function documentPaletteId(document: LogoDocument): string {
  const palette = document.palettes[0];
  if (!palette) {
    return PALETTES[0]!.id;
  }
  return PALETTES.find(
    (candidate) =>
      candidate.name === palette?.name &&
      candidate.paper === palette.colors[0] &&
      candidate.ink === palette.colors[1] &&
      candidate.accent === palette.colors[2],
  )?.id ?? PALETTES[0]!.id;
}

function paletteOptions(
  selectedId: string,
  seed: number,
  vibe?: Vibe,
): readonly FoundryPalette[] {
  const eligible = vibe
    ? PALETTES.filter((palette) => palette.vibes.includes(vibe))
    : PALETTES;
  const selected = PALETTES.find((palette) => palette.id === selectedId)!;
  const options = [selected];
  for (let offset = 0; options.length < Math.min(4, eligible.length); offset += 1) {
    const candidate = eligible[(seed + offset) % eligible.length]!;
    if (!options.some((palette) => palette.id === candidate.id)) {
      options.push(candidate);
    }
  }
  return options;
}

/** Build dashboard cards synchronously; font fetching remains a separate gate. */
export function buildTemplateProposals({
  brandName,
  tagline,
  vibe,
  shuffleRound,
  count = 18,
  paletteOverrides = {},
}: TemplateProposalInput): TemplateProposal[] {
  return Array.from({ length: count }, (_, index) => {
    const archetypeId = ARCHETYPE_IDS[index % ARCHETYPE_IDS.length]!;
    const seed = seedFor(shuffleRound, index, archetypeId);
    const key = `${archetypeId}-${seed}`;
    const document = generate({
      brandName,
      ...(tagline?.trim() ? { tagline } : {}),
      archetypeId,
      ...(vibe ? { vibe } : {}),
      ...(paletteOverrides[key] ? { paletteId: paletteOverrides[key] } : {}),
      seed,
    });
    const paletteId = documentPaletteId(document);
    return {
      key,
      archetypeId,
      archetypeLabel: labels.get(archetypeId) ?? archetypeId,
      seed,
      paletteId,
      paletteOptions: paletteOptions(paletteId, seed, vibe),
      document,
      svg: documentToSvg(document),
      fonts: collectDocumentFontFaces(document),
    };
  });
}
