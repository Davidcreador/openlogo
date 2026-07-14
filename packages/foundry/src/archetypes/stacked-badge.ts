import { motifById } from "../ingredients";
import type { ArchetypeMetadata } from "../types";
import {
  addRule,
  balancedLineBreak,
  displayBrand,
  displayStyle,
  fitFontSize,
  jitter,
  type RecipeContext,
  supportingStyle,
  tracking,
} from "./shared";

export const metadata: ArchetypeMetadata = {
  id: "stacked-badge",
  label: "Stacked Badge",
  width: 600,
  height: 600,
  parameterRanges: [
    { parameter: "safe inset", range: "42–46 px", rationale: "Every visible edge clears the 6% margin." },
    { parameter: "divider motif", range: "24–26 px", rationale: "Motifs lock to the divider and cap-height scale." },
    { parameter: "stroke", range: "5–6 px", rationale: "Both keylines use one banked weight." },
  ],
};

export function render(context: RecipeContext): void {
  const { builder, palette, random, fonts, recipe } = context;
  const inset = jitter(random, 44, 2);
  const cornerRadius = recipe.id === "stacked-modern"
    ? 30
    : recipe.id === "stacked-utility"
      ? 6
      : 18;

  builder.addRectangle({
    role: "badge-frame",
    name: "Badge frame",
    x: inset,
    y: inset,
    width: 600 - inset * 2,
    height: 600 - inset * 2,
    fill: palette.paper,
    stroke: { color: palette.ink, width: recipe.strokeWidth },
    cornerRadius,
  });
  builder.addRectangle({
    role: "inner-frame",
    name: "Inner keyline",
    x: inset + 14,
    y: inset + 14,
    width: 600 - (inset + 14) * 2,
    height: 600 - (inset + 14) * 2,
    fill: palette.paper,
    stroke: { color: palette.accent, width: recipe.strokeWidth },
    cornerRadius: Math.max(2, cornerRadius - 8),
  });

  const dividerY = jitter(random, 166, 1);
  const dividerSize = recipe.id === "stacked-modern" ? 26 : 24;
  addRule(builder, "rule-left", 114, dividerY, 162, palette.accent, 4);
  builder.addMotif(motifById(recipe.motifIds[0] ?? "diamond"), {
    role: "divider-mark",
    x: 300 - dividerSize / 2,
    y: dividerY - dividerSize / 2 + 2,
    width: dividerSize,
    height: dividerSize,
    fill: palette.accent,
  });
  addRule(builder, "rule-right", 324, dividerY, 162, palette.accent, 4);

  const brand = displayBrand(context);
  const brandLines = balancedLineBreak(brand);
  const longestLine = brandLines
    .split("\n")
    .reduce((longest, line) => line.length > longest.length ? line : longest);
  const lineCount = brandLines.includes("\n") ? 2 : 1;
  const uppercase = brand === brand.toLocaleUpperCase();
  const trackingEm = uppercase ? recipe.trackingPerMille / 1000 : 0;
  const widthFactor = recipe.id === "stacked-heritage"
    ? 0.72
    : recipe.id === "stacked-utility"
      ? 0.63
      : 0.64;
  const size = fitFontSize(
    longestLine,
    440,
    40,
    recipe.id === "stacked-utility" ? 84 : 74,
    widthFactor,
    trackingEm,
  );
  const brandCenterY = context.tagline ? 258 : 292;
  const brandHeight = size * (1 + (lineCount - 1) * 1.02);
  builder.addText({
    role: "brand",
    name: "Brand name",
    x: 80,
    y: Math.round(brandCenterY - brandHeight / 2),
    width: 440,
    height: brandHeight * 1.08,
    fill: palette.ink,
    content: brandLines,
    ...displayStyle(fonts),
    fontSize: size,
    lineHeight: 1.02,
    letterSpacing: uppercase ? tracking(size, recipe.trackingPerMille) : 0,
    align: "center",
  });

  if (context.tagline) {
    const preferred = Math.max(10, Math.min(22, Math.floor(size * 0.36)));
    const taglineSize = fitFontSize(
      context.tagline,
      400,
      10,
      preferred,
      0.62,
      recipe.trackingPerMille / 1000,
    );
    builder.addText({
      role: "tagline",
      name: "Tagline",
      x: 100,
      y: 350,
      width: 400,
      height: taglineSize * 1.15,
      fill: palette.ink,
      content: context.tagline.toLocaleUpperCase(),
      ...supportingStyle(fonts),
      fontSize: taglineSize,
      letterSpacing: tracking(taglineSize, recipe.trackingPerMille),
      align: "center",
    });
  }

  addRule(
    builder,
    "bottom-rule",
    180,
    context.tagline ? 416 : 382,
    240,
    palette.accent,
    4,
  );
}
