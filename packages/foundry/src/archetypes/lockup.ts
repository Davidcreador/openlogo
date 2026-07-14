import { motifById } from "../ingredients";
import type { ArchetypeMetadata } from "../types";
import {
  displayBrand,
  displayStyle,
  fitFontSize,
  type RecipeContext,
  supportingStyle,
  tracking,
} from "./shared";

export const metadata: ArchetypeMetadata = {
  id: "lockup",
  label: "Lockup",
  width: 800,
  height: 400,
  parameterRanges: [
    { parameter: "mark container", range: "144 px", rationale: "A keyline integrates motifs and protects type hierarchy." },
    { parameter: "motif", range: "34–52 px", rationale: "Symbol size follows the fitted brand cap height." },
    { parameter: "text column", range: "510 px", rationale: "Long names shrink before reaching the safe margin." },
  ],
};

export function render(context: RecipeContext): void {
  const { builder, palette, fonts, recipe } = context;
  const brand = displayBrand(context);
  const uppercase = brand === brand.toLocaleUpperCase();
  const trackingEm = uppercase ? recipe.trackingPerMille / 1000 : 0;
  const widthFactor = recipe.id === "lockup-utility" ? 0.68 : 0.6;
  const brandSize = fitFontSize(
    brand,
    510,
    38,
    68,
    widthFactor,
    trackingEm,
  );
  const preferred = Math.max(10, Math.min(22, Math.floor(brandSize * 0.36)));
  const taglineSize = context.tagline
    ? fitFontSize(
        context.tagline,
        510,
        10,
        preferred,
        0.62,
        recipe.trackingPerMille / 1000,
      )
    : 0;

  const markX = 58;
  const markY = 128;
  const markSize = 144;
  if (recipe.id === "lockup-roundel") {
    builder.addEllipse({
      role: "mark-container",
      name: "Mark container",
      x: markX,
      y: markY,
      width: markSize,
      height: markSize,
      fill: palette.paper,
      stroke: { color: palette.ink, width: recipe.strokeWidth },
    });
  } else {
    builder.addRectangle({
      role: "mark-container",
      name: "Mark container",
      x: markX,
      y: markY,
      width: markSize,
      height: markSize,
      fill: palette.paper,
      stroke: { color: palette.ink, width: recipe.strokeWidth },
      cornerRadius: recipe.id === "lockup-plaque" ? 20 : 5,
    });
  }

  const motifSize = Math.max(34, Math.min(52, Math.round(brandSize * 0.74)));
  builder.addMotif(motifById(recipe.motifIds[0] ?? "diamond"), {
    role: "mark-motif",
    name: "Contained mark",
    x: markX + (markSize - motifSize) / 2,
    y: markY + (markSize - motifSize) / 2,
    width: motifSize,
    height: motifSize,
    fill: palette.accent,
  });

  builder.addText({
    role: "brand",
    name: "Brand name",
    x: 242,
    y: context.tagline
      ? Math.round(178 - brandSize / 2)
      : Math.round(200 - brandSize / 2),
    width: 510,
    height: brandSize * 1.08,
    fill: palette.ink,
    content: brand,
    ...displayStyle(fonts),
    fontSize: brandSize,
    letterSpacing: uppercase
      ? tracking(brandSize, recipe.trackingPerMille)
      : 0,
  });
  if (context.tagline) {
    builder.addText({
      role: "tagline",
      name: "Tagline",
      x: 242,
      y: 226,
      width: 510,
      height: taglineSize * 1.15,
      fill: palette.ink,
      content: context.tagline.toLocaleUpperCase(),
      ...supportingStyle(fonts),
      fontSize: taglineSize,
      letterSpacing: tracking(taglineSize, recipe.trackingPerMille),
    });
  }
}
