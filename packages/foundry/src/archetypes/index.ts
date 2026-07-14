import type { LogoVariant } from "@openlogo/core";
import type { ArchetypeId, ArchetypeMetadata } from "../types";
import * as cartouche from "./cartouche";
import * as circularSeal from "./circular-seal";
import * as lockup from "./lockup";
import * as monogram from "./monogram";
import type { RecipeContext } from "./shared";
import * as stackedBadge from "./stacked-badge";
import * as wordmark from "./wordmark";

export type ArchetypeRecipe = {
  metadata: ArchetypeMetadata;
  purpose: LogoVariant;
  render(context: RecipeContext): void;
};

export const ARCHETYPES: readonly ArchetypeMetadata[] = [
  wordmark.metadata,
  stackedBadge.metadata,
  circularSeal.metadata,
  monogram.metadata,
  cartouche.metadata,
  lockup.metadata,
];

const RECIPES: Record<ArchetypeId, ArchetypeRecipe> = {
  wordmark: { metadata: wordmark.metadata, purpose: "wordmark", render: wordmark.render },
  "stacked-badge": { metadata: stackedBadge.metadata, purpose: "stacked", render: stackedBadge.render },
  "circular-seal": { metadata: circularSeal.metadata, purpose: "icon", render: circularSeal.render },
  monogram: { metadata: monogram.metadata, purpose: "icon", render: monogram.render },
  cartouche: { metadata: cartouche.metadata, purpose: "primary", render: cartouche.render },
  lockup: { metadata: lockup.metadata, purpose: "horizontal", render: lockup.render },
};

export function recipeFor(id: ArchetypeId): ArchetypeRecipe {
  return RECIPES[id];
}
