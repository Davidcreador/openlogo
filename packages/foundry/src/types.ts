export const VIBES = [
  "minimal",
  "classic",
  "retro",
  "streetwear",
  "elegant",
  "playful",
] as const;

export type Vibe = (typeof VIBES)[number];

export const ARCHETYPE_IDS = [
  "wordmark",
  "stacked-badge",
  "circular-seal",
  "monogram",
  "cartouche",
  "lockup",
] as const;

export type ArchetypeId = (typeof ARCHETYPE_IDS)[number];

export type GenerateInput = {
  brandName: string;
  tagline?: string;
  archetypeId: ArchetypeId;
  vibe?: Vibe;
  /** Select an exact curated palette without changing the seeded layout. */
  paletteId?: FoundryPalette["id"];
  seed: number;
};

export type FontChoice = {
  family: string;
  weight: number;
  style?: "normal" | "italic";
};

export type FontPairing = {
  id: string;
  display: FontChoice;
  supporting: FontChoice;
  vibes: readonly Vibe[];
};

export type FoundryPalette = {
  id: string;
  name: string;
  /** Substrate color; never sampled independently from the ink roles. */
  paper: string;
  /** Dominant high-contrast ink. */
  ink: string;
  /** Secondary ink, reserved for structure and restrained emphasis. */
  accent: string;
  vibes: readonly Vibe[];
};

export type Motif = {
  id: string;
  name: string;
  d: string;
  viewBox: { width: number; height: number };
  vibes: readonly Vibe[];
};

export type ParameterRange = {
  parameter: string;
  range: string;
  rationale: string;
};

export type ArchetypeMetadata = {
  id: ArchetypeId;
  label: string;
  width: number;
  height: number;
  parameterRanges: readonly ParameterRange[];
};
