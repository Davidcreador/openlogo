import {
  DOCUMENT_SCHEMA_VERSION,
  type LogoDocument,
} from "@openlogo/core";
import { recipeFor } from "./archetypes";
import { NodeBuilder } from "./archetypes/shared";
import { createPrng, normalizeSeed } from "./prng";
import {
  fontPairingFor,
  paletteFor,
  recipesFor,
} from "./recipes";
import {
  ARCHETYPE_IDS,
  type ArchetypeId,
  type GenerateInput,
  type Vibe,
  VIBES,
} from "./types";

function isArchetypeId(value: string): value is ArchetypeId {
  return (ARCHETYPE_IDS as readonly string[]).includes(value);
}

function isVibe(value: string): value is Vibe {
  return (VIBES as readonly string[]).includes(value);
}

function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/** Generate one deterministic, editable Logo Document from curated primitives. */
export function generate(input: GenerateInput): LogoDocument {
  if (!isArchetypeId(input.archetypeId)) {
    throw new RangeError(`Unknown archetype: ${String(input.archetypeId)}`);
  }
  if (input.vibe !== undefined && !isVibe(input.vibe)) {
    throw new RangeError(`Unknown vibe: ${String(input.vibe)}`);
  }

  const seed = normalizeSeed(input.seed);
  const random = createPrng(seed);
  const bankedRecipe = random.pick(recipesFor(input.archetypeId, input.vibe));
  const vibe = input.vibe ?? random.pick(bankedRecipe.vibes);
  const fonts = fontPairingFor(bankedRecipe);
  const palette = paletteFor(input.paletteId ?? bankedRecipe.paletteId);
  const archetype = recipeFor(input.archetypeId);
  const prefix = `foundry-${seed.toString(36)}-${input.archetypeId}`;
  const builder = new NodeBuilder(`${prefix}-node`);
  const brandName = cleanText(input.brandName) || "Brand";
  const cleanedTagline = input.tagline === undefined ? "" : cleanText(input.tagline);

  archetype.render({
    brandName,
    ...(cleanedTagline ? { tagline: cleanedTagline } : {}),
    vibe,
    palette,
    fonts,
    recipe: bankedRecipe,
    random,
    builder,
  });

  const artboardId = `${prefix}-artboard`;
  return {
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    id: `${prefix}-document`,
    name: `${brandName} — ${archetype.metadata.label}`,
    activeArtboardId: artboardId,
    artboards: [
      {
        id: artboardId,
        name: archetype.metadata.label,
        x: 0,
        y: 0,
        width: archetype.metadata.width,
        height: archetype.metadata.height,
        background: palette.paper,
        purpose: archetype.purpose,
        nodeIds: builder.nodeIds,
      },
    ],
    nodes: builder.nodes,
    palettes: [
      {
        id: `${prefix}-palette`,
        name: palette.name,
        colors: [palette.paper, palette.ink, palette.accent],
      },
    ],
    designBrief: { brandName },
  };
}
