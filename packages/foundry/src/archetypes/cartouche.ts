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
  id: "cartouche",
  label: "Cartouche",
  width: 720,
  height: 480,
  parameterRanges: [
    { parameter: "frame inset", range: "51–53 px", rationale: "Keylines retain a true export margin." },
    { parameter: "ribbon panel", range: "208 px", rationale: "Tagline fits the banner's actual center panel, not its tails." },
    { parameter: "ornament", range: "42 px max", rationale: "Grid-aligned detail stays subordinate to type." },
  ],
};

export function render(context: RecipeContext): void {
  const { builder, palette, random, fonts, recipe } = context;
  const inset = jitter(random, 52, 1);
  const radius = recipe.id === "cartouche-deco"
    ? 18
    : recipe.id === "cartouche-makers"
      ? 8
      : 34;

  builder.addRectangle({
    role: "outer-frame",
    name: "Cartouche frame",
    x: inset,
    y: 52,
    width: 720 - inset * 2,
    height: 376,
    fill: palette.paper,
    stroke: { color: palette.ink, width: recipe.strokeWidth },
    cornerRadius: radius,
  });
  builder.addRectangle({
    role: "inner-frame",
    name: "Inner keyline",
    x: inset + 12,
    y: 64,
    width: 720 - (inset + 12) * 2,
    height: 352,
    fill: palette.paper,
    stroke: { color: palette.accent, width: recipe.strokeWidth },
    cornerRadius: Math.max(3, radius - 10),
  });

  if (recipe.id === "cartouche-crown") {
    builder.addMotif(motifById("crown"), {
      role: "header-ornament",
      x: 339,
      y: 86,
      width: 42,
      height: 42,
      fill: palette.accent,
    });
  } else {
    const ornament = motifById(recipe.motifIds[0] ?? "diamond");
    const size = recipe.id === "cartouche-makers" ? 22 : 18;
    addRule(builder, "header-rule-left", 238, 104, 88, palette.accent, 4);
    builder.addMotif(ornament, {
      role: "header-ornament",
      x: 360 - size / 2,
      y: 106 - size / 2,
      width: size,
      height: size,
      fill: palette.accent,
    });
    addRule(builder, "header-rule-right", 394, 104, 88, palette.accent, 4);
  }

  const brand = displayBrand(context);
  const brandLines = balancedLineBreak(brand);
  const longestLine = brandLines
    .split("\n")
    .reduce((longest, line) => line.length > longest.length ? line : longest);
  const lineCount = brandLines.includes("\n") ? 2 : 1;
  const uppercase = brand === brand.toLocaleUpperCase();
  const trackingEm = uppercase ? recipe.trackingPerMille / 1000 : 0;
  const widthFactor = recipe.id === "cartouche-makers" ? 0.52 : 0.6;
  const brandSize = fitFontSize(
    longestLine,
    440,
    34,
    recipe.id === "cartouche-makers" ? 76 : 68,
    widthFactor,
    trackingEm,
  );
  const brandHeight = brandSize * (1 + (lineCount - 1) * 1.02);
  builder.addText({
    role: "brand",
    name: "Brand name",
    x: 140,
    y: Math.round(205 - brandHeight / 2),
    width: 440,
    height: brandHeight * 1.08,
    fill: palette.ink,
    content: brandLines,
    ...displayStyle(fonts),
    fontSize: brandSize,
    lineHeight: 1.02,
    letterSpacing: uppercase
      ? tracking(brandSize, recipe.trackingPerMille)
      : 0,
    align: "center",
  });

  if (context.tagline) {
    builder.addMotif(motifById("banner"), {
      role: "tagline-banner",
      name: "Tagline ribbon",
      x: 160,
      y: 282,
      width: 400,
      height: 96,
      fill: palette.accent,
    });
    const preferred = Math.max(10, Math.min(18, Math.floor(brandSize * 0.38)));
    const taglineSize = fitFontSize(
      context.tagline,
      190,
      10,
      preferred,
      0.62,
      recipe.trackingPerMille / 1000,
    );
    builder.addText({
      role: "tagline",
      name: "Tagline",
      x: 265,
      y: 310,
      width: 190,
      height: taglineSize * 1.15,
      fill: palette.ink,
      content: context.tagline.toLocaleUpperCase(),
      ...supportingStyle(fonts),
      fontSize: taglineSize,
      letterSpacing: tracking(taglineSize, recipe.trackingPerMille),
      align: "center",
    });
  }
}
