import { motifById } from "../ingredients";
import type { ArchetypeMetadata } from "../types";
import {
  displayStyle,
  fitFontSize,
  initials,
  type RecipeContext,
  supportingStyle,
  tracking,
} from "./shared";

export const metadata: ArchetypeMetadata = {
  id: "monogram",
  label: "Monogram",
  width: 500,
  height: 600,
  parameterRanges: [
    { parameter: "frame", range: "3 banked silhouettes", rationale: "Circle, diamond, and shield each get optical type placement." },
    { parameter: "initial count", range: "1–2 word initials", rationale: "Single-word brands never become accidental words." },
    { parameter: "type sizes", range: "2", rationale: "Identity and supporting copy keep strict hierarchy." },
  ],
};

export function render(context: RecipeContext): void {
  const { builder, palette, fonts, recipe } = context;
  const isRound = recipe.id === "monogram-round";
  const isShield = recipe.id === "monogram-shield";
  const frameX = 84;
  const frameY = 60;
  const frameSize = 332;

  if (isRound) {
    builder.addEllipse({
      role: "frame",
      name: "Monogram frame",
      x: frameX,
      y: frameY,
      width: frameSize,
      height: frameSize,
      fill: palette.paper,
      stroke: { color: palette.ink, width: recipe.strokeWidth },
    });
  } else {
    builder.addMotif(
      motifById(isShield ? "shield" : "diamond"),
      {
        role: "frame",
        name: "Monogram frame",
        x: frameX,
        y: frameY,
        width: frameSize,
        height: frameSize,
        fill: palette.paper,
        stroke: { color: palette.ink, width: recipe.strokeWidth },
      },
    );
  }

  const mark = initials(context.brandName);
  const nominalMarkSize = isShield ? 142 : isRound ? 132 : 128;
  const markSize = mark.length > 1
    ? Math.round(nominalMarkSize * 0.82)
    : nominalMarkSize;
  builder.addText({
    role: "initials",
    name: "Initials",
    x: 112,
    y: frameY + (isShield ? 118 : 102),
    width: 276,
    height: markSize * 1.08,
    fill: palette.accent,
    content: mark,
    ...displayStyle(fonts),
    fontSize: markSize,
    letterSpacing: tracking(markSize, 60),
    align: "center",
  });

  const brand = context.brandName.toLocaleUpperCase();
  const trackingEm = recipe.trackingPerMille / 1000;
  const brandFit = fitFontSize(brand, 420, 16, 28, 0.62, trackingEm);
  const taglineFit = context.tagline
    ? fitFontSize(context.tagline, 360, 16, 28, 0.6)
    : 28;
  const labelSize = Math.min(brandFit, taglineFit);

  builder.addText({
    role: "brand",
    name: "Brand name",
    x: 40,
    y: context.tagline ? 438 : 466,
    width: 420,
    height: labelSize * 1.15,
    fill: palette.ink,
    content: brand,
    ...supportingStyle(fonts),
    fontSize: labelSize,
    letterSpacing: tracking(labelSize, recipe.trackingPerMille),
    align: "center",
  });
  if (context.tagline) {
    builder.addText({
      role: "tagline",
      name: "Tagline",
      x: 70,
      y: 496,
      width: 360,
      height: labelSize * 1.15,
      fill: palette.accent,
      content: context.tagline,
      ...supportingStyle(fonts),
      fontWeight: 400,
      fontSize: labelSize,
      align: "center",
    });
  }
}
