import { FONT_PAIRINGS, PALETTES } from "./ingredients";
import type {
  ArchetypeId,
  FontPairing,
  FoundryPalette,
  Motif,
  Vibe,
} from "./types";

export type FoundryRecipe = {
  id: string;
  archetypeId: ArchetypeId;
  vibes: readonly Vibe[];
  fontPairingId: string;
  paletteId: string;
  motifIds: readonly Motif["id"][];
  brandCase: "original" | "uppercase";
  trackingPerMille: 80 | 100 | 120;
  strokeWidth: 5 | 6;
};

/**
 * Complete compositions, not ingredient buckets. Each entry was authored as
 * one font + paper/ink/accent + motif/layout decision. Seeds only choose an
 * eligible entry; renderers may move banked measurements by at most 2 px.
 */
export const RECIPE_BANK = [
  { id: "wordmark-editorial", archetypeId: "wordmark", vibes: ["classic", "elegant"], fontPairingId: "playfair-montserrat", paletteId: "porcelain-navy", motifIds: [], brandCase: "original", trackingPerMille: 80, strokeWidth: 5 },
  { id: "wordmark-modern", archetypeId: "wordmark", vibes: ["minimal", "playful"], fontPairingId: "space-grotesk-inter", paletteId: "ice-slate", motifIds: ["diamond"], brandCase: "original", trackingPerMille: 100, strokeWidth: 5 },
  { id: "wordmark-utility", archetypeId: "wordmark", vibes: ["retro", "streetwear"], fontPairingId: "bebas-work-sans", paletteId: "fog-black-red", motifIds: [], brandCase: "uppercase", trackingPerMille: 120, strokeWidth: 6 },

  { id: "stacked-heritage", archetypeId: "stacked-badge", vibes: ["classic", "elegant"], fontPairingId: "lora-work-sans", paletteId: "cream-oxblood", motifIds: ["diamond"], brandCase: "uppercase", trackingPerMille: 100, strokeWidth: 5 },
  { id: "stacked-modern", archetypeId: "stacked-badge", vibes: ["minimal", "playful"], fontPairingId: "poppins-inter", paletteId: "chalk-cobalt", motifIds: ["spark"], brandCase: "original", trackingPerMille: 80, strokeWidth: 5 },
  { id: "stacked-utility", archetypeId: "stacked-badge", vibes: ["retro", "streetwear"], fontPairingId: "oswald-montserrat", paletteId: "butter-brick", motifIds: ["diamond"], brandCase: "uppercase", trackingPerMille: 120, strokeWidth: 6 },

  { id: "seal-heritage", archetypeId: "circular-seal", vibes: ["classic", "elegant"], fontPairingId: "dm-serif-poppins", paletteId: "parchment-forest", motifIds: ["diamond"], brandCase: "uppercase", trackingPerMille: 100, strokeWidth: 6 },
  { id: "seal-modern", archetypeId: "circular-seal", vibes: ["minimal", "playful"], fontPairingId: "playfair-montserrat", paletteId: "ivory-carbon", motifIds: ["spark"], brandCase: "uppercase", trackingPerMille: 120, strokeWidth: 5 },
  { id: "seal-trade", archetypeId: "circular-seal", vibes: ["retro", "streetwear"], fontPairingId: "lora-work-sans", paletteId: "sand-espresso", motifIds: ["diamond"], brandCase: "uppercase", trackingPerMille: 100, strokeWidth: 6 },

  { id: "monogram-round", archetypeId: "monogram", vibes: ["minimal", "playful"], fontPairingId: "dm-serif-poppins", paletteId: "blush-plum", motifIds: [], brandCase: "uppercase", trackingPerMille: 80, strokeWidth: 5 },
  { id: "monogram-diamond", archetypeId: "monogram", vibes: ["classic", "elegant"], fontPairingId: "playfair-montserrat", paletteId: "porcelain-navy", motifIds: ["diamond"], brandCase: "uppercase", trackingPerMille: 100, strokeWidth: 5 },
  { id: "monogram-shield", archetypeId: "monogram", vibes: ["retro", "streetwear"], fontPairingId: "bebas-work-sans", paletteId: "fog-black-red", motifIds: ["shield"], brandCase: "uppercase", trackingPerMille: 120, strokeWidth: 6 },

  { id: "cartouche-crown", archetypeId: "cartouche", vibes: ["classic", "elegant"], fontPairingId: "playfair-montserrat", paletteId: "cream-oxblood", motifIds: ["crown", "banner"], brandCase: "original", trackingPerMille: 80, strokeWidth: 5 },
  { id: "cartouche-deco", archetypeId: "cartouche", vibes: ["minimal", "playful"], fontPairingId: "dm-serif-poppins", paletteId: "lilac-aubergine", motifIds: ["diamond", "banner"], brandCase: "original", trackingPerMille: 100, strokeWidth: 5 },
  { id: "cartouche-makers", archetypeId: "cartouche", vibes: ["retro", "streetwear"], fontPairingId: "oswald-montserrat", paletteId: "sand-espresso", motifIds: ["spark", "banner"], brandCase: "uppercase", trackingPerMille: 120, strokeWidth: 6 },

  { id: "lockup-roundel", archetypeId: "lockup", vibes: ["classic", "elegant"], fontPairingId: "lora-work-sans", paletteId: "parchment-forest", motifIds: ["leaf"], brandCase: "original", trackingPerMille: 80, strokeWidth: 5 },
  { id: "lockup-plaque", archetypeId: "lockup", vibes: ["minimal", "playful"], fontPairingId: "raleway-lora", paletteId: "mist-denim", motifIds: ["diamond"], brandCase: "original", trackingPerMille: 100, strokeWidth: 5 },
  { id: "lockup-utility", archetypeId: "lockup", vibes: ["retro", "streetwear"], fontPairingId: "archivo-space-mono", paletteId: "ice-slate", motifIds: ["spark"], brandCase: "uppercase", trackingPerMille: 120, strokeWidth: 6 },
] as const satisfies readonly FoundryRecipe[];

export function recipesFor(
  archetypeId: ArchetypeId,
  vibe?: Vibe,
): readonly FoundryRecipe[] {
  return RECIPE_BANK.filter(
    (recipe) =>
      recipe.archetypeId === archetypeId &&
      (vibe === undefined ||
        (recipe.vibes as readonly Vibe[]).includes(vibe)),
  );
}

export function fontPairingFor(recipe: FoundryRecipe): FontPairing {
  const pairing = FONT_PAIRINGS.find(
    (candidate) => candidate.id === recipe.fontPairingId,
  );
  if (!pairing) {
    throw new RangeError(`Unknown font pairing: ${recipe.fontPairingId}`);
  }
  return pairing;
}

export function paletteFor(id: string): FoundryPalette {
  const palette = PALETTES.find((candidate) => candidate.id === id);
  if (!palette) {
    throw new RangeError(`Unknown palette: ${id}`);
  }
  return palette;
}
