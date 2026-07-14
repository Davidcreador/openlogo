import { motifById } from "../ingredients";
import type { ArchetypeMetadata } from "../types";
import {
  addRule,
  displayBrand,
  displayStyle,
  fitFontSize,
  jitter,
  type RecipeContext,
  supportingStyle,
  tracking,
} from "./shared";

export const metadata: ArchetypeMetadata = {
  id: "wordmark",
  label: "Wordmark",
  width: 720,
  height: 320,
  parameterRanges: [
    { parameter: "composition", range: "3 banked layouts", rationale: "Type, palette, and decoration are reviewed together." },
    { parameter: "tracking", range: "80–120/1000 em", rationale: "Uppercase copy stays deliberate and readable." },
    { parameter: "jitter", range: "±2 px", rationale: "Seeds vary polish without changing hierarchy." },
  ],
};

export function render(context: RecipeContext): void {
  const { builder, palette, random, fonts, recipe } = context;
  const brand = displayBrand(context);
  const uppercase = brand === brand.toLocaleUpperCase();
  const trackingEm = uppercase ? recipe.trackingPerMille / 1000 : 0;
  const maxSize = recipe.id === "wordmark-utility" ? 108 : 98;
  const widthFactor = recipe.id === "wordmark-utility" ? 0.52 : 0.6;
  const fontSize = fitFontSize(
    brand,
    604,
    52,
    maxSize,
    widthFactor,
    trackingEm,
  );
  const centerY = context.tagline ? 126 : 145;
  const brandY = Math.round(centerY - fontSize / 2);

  builder.addText({
    role: "brand",
    name: "Brand name",
    x: 58,
    y: brandY,
    width: 604,
    height: fontSize * 1.08,
    fill: palette.ink,
    content: brand,
    ...displayStyle(fonts),
    fontSize,
    letterSpacing: uppercase ? tracking(fontSize, recipe.trackingPerMille) : 0,
    align: "center",
  });

  const ruleY = jitter(random, context.tagline ? 192 : 212, 1);
  if (recipe.id === "wordmark-modern") {
    addRule(builder, "rule-left", 190, ruleY, 142, palette.accent, 4);
    builder.addMotif(motifById(recipe.motifIds[0] ?? "diamond"), {
      role: "rule-mark",
      x: 348,
      y: ruleY - 10,
      width: 24,
      height: 24,
      fill: palette.accent,
    });
    addRule(builder, "rule-right", 388, ruleY, 142, palette.accent, 4);
  } else {
    addRule(builder, "underline", 200, ruleY, 320, palette.accent, 4);
  }

  if (context.tagline) {
    const preferred = Math.max(10, Math.min(22, Math.floor(fontSize * 0.36)));
    const taglineSize = fitFontSize(
      context.tagline,
      480,
      10,
      preferred,
      0.62,
      recipe.trackingPerMille / 1000,
    );
    builder.addText({
      role: "tagline",
      name: "Tagline",
      x: 120,
      y: 226,
      width: 480,
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
