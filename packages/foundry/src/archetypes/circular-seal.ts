import { motifById } from "../ingredients";
import type { ArchetypeMetadata } from "../types";
import {
  displayStyle,
  initials,
  jitter,
  type RecipeContext,
  supportingStyle,
  tracking,
} from "./shared";

const ARC_LENGTH = 408;
const ARC_WIDTH = 370;
const ARC_SIDE_MARGIN = (ARC_LENGTH - ARC_WIDTH) / 2;
const MIN_ARC_SIZE = 14;
const MAX_ARC_SIZE = 25;
const UNKNOWN_GLYPH_WIDTH = 1.2;

// Uppercase advance widths, rounded up to 0.01 em, for the three supporting
// faces used by seal recipes. Unknown glyphs take a deliberately wide fallback.
const ARC_GLYPH_WIDTHS: Record<string, Readonly<Record<string, number>>> = {
  Montserrat: {
    " ": 0.27,
    "0": 0.67, "1": 0.37, "2": 0.58, "3": 0.58, "4": 0.67,
    "5": 0.58, "6": 0.62, "7": 0.6, "8": 0.65, "9": 0.62,
    A: 0.74, B: 0.76, C: 0.72, D: 0.83, E: 0.67, F: 0.64,
    G: 0.78, H: 0.82, I: 0.31, J: 0.52, K: 0.72, L: 0.6,
    M: 0.96, N: 0.82, O: 0.84, P: 0.73, Q: 0.84, R: 0.73,
    S: 0.63, T: 0.59, U: 0.8, V: 0.72, W: 1.13, X: 0.68,
    Y: 0.65, Z: 0.66, "&": 0.69,
  },
  Poppins: {
    " ": 0.26,
    "0": 0.65, "1": 0.35, "2": 0.58, "3": 0.6, "4": 0.65,
    "5": 0.64, "6": 0.65, "7": 0.56, "8": 0.64, "9": 0.64,
    A: 0.7, B: 0.63, C: 0.78, D: 0.71, E: 0.53, F: 0.52,
    G: 0.78, H: 0.71, I: 0.27, J: 0.57, K: 0.64, L: 0.45,
    M: 0.89, N: 0.73, O: 0.79, P: 0.6, Q: 0.79, R: 0.64,
    S: 0.61, T: 0.57, U: 0.69, V: 0.7, W: 1, X: 0.66,
    Y: 0.61, Z: 0.56, "&": 0.77,
  },
  "Work Sans": {
    " ": 0.33,
    "0": 0.63, "1": 0.41, "2": 0.59, "3": 0.59, "4": 0.63,
    "5": 0.59, "6": 0.62, "7": 0.58, "8": 0.62, "9": 0.62,
    A: 0.67, B: 0.67, C: 0.69, D: 0.72, E: 0.64, F: 0.62,
    G: 0.73, H: 0.74, I: 0.31, J: 0.59, K: 0.67, L: 0.6,
    M: 0.88, N: 0.74, O: 0.75, P: 0.63, Q: 0.75, R: 0.68,
    S: 0.65, T: 0.62, U: 0.71, V: 0.66, W: 0.98, X: 0.62,
    Y: 0.6, Z: 0.64, "&": 0.63,
  },
};

function arcTextWidth(
  content: string,
  fontFamily: string,
  fontSize: number,
  letterSpacing: number,
): number {
  const widths = ARC_GLYPH_WIDTHS[fontFamily];
  const glyphs = Array.from(content);
  const advance = glyphs.reduce((sum, glyph) => {
    const baseGlyph = glyph.normalize("NFD").replace(/\p{M}/gu, "")[0] ?? glyph;
    return sum + (widths?.[baseGlyph] ?? UNKNOWN_GLYPH_WIDTH);
  }, 0);
  return advance * fontSize
    + Math.max(0, glyphs.length - 1) * letterSpacing;
}

function fitArcSize(
  content: string,
  fontFamily: string,
  trackingPerMille: number,
): number | null {
  for (let size = MAX_ARC_SIZE; size >= MIN_ARC_SIZE; size -= 1) {
    if (
      arcTextWidth(content, fontFamily, size, tracking(size, trackingPerMille))
      <= ARC_WIDTH
    ) {
      return size;
    }
  }
  return null;
}

function arcStartOffset(
  content: string,
  fontFamily: string,
  fontSize: number,
  letterSpacing: number,
): number {
  const centered = (
    ARC_LENGTH
    - arcTextWidth(content, fontFamily, fontSize, letterSpacing)
  ) / 2;
  return Math.max(ARC_SIDE_MARGIN, Math.round(centered * 100) / 100);
}

export const metadata: ArchetypeMetadata = {
  id: "circular-seal",
  label: "Circular Seal",
  width: 600,
  height: 600,
  parameterRanges: [
    { parameter: "ring inset", range: "46–50 px", rationale: "Equal keylines stay beyond the 6% safe margin." },
    { parameter: "arc type", range: "14–25 px", rationale: "Both arcs share one fitted size; text that cannot stay legible yields to the center monogram." },
    { parameter: "separator", range: "16–18 px", rationale: "Paired marks connect the two text arcs." },
  ],
};

export function render(context: RecipeContext): void {
  const { builder, palette, random, fonts, recipe } = context;
  const outerInset = jitter(random, 48, 2);
  const ringDiameter = 600 - outerInset * 2;
  builder.addEllipse({
    role: "outer-ring",
    name: "Outer ring",
    x: outerInset,
    y: outerInset,
    width: ringDiameter,
    height: ringDiameter,
    fill: palette.paper,
    stroke: { color: palette.ink, width: recipe.strokeWidth },
  });
  builder.addEllipse({
    role: "inner-ring",
    name: "Inner ring",
    x: outerInset + 22,
    y: outerInset + 22,
    width: ringDiameter - 44,
    height: ringDiameter - 44,
    fill: palette.paper,
    stroke: { color: palette.accent, width: recipe.strokeWidth },
  });

  const brand = context.brandName.toLocaleUpperCase();
  const tagline = context.tagline?.toLocaleUpperCase();
  const arcFontFamily = fonts.supporting.family;
  const brandFit = fitArcSize(brand, arcFontFamily, recipe.trackingPerMille);
  const taglineFit = tagline
    ? fitArcSize(tagline, arcFontFamily, recipe.trackingPerMille)
    : null;
  const fittedSizes = [brandFit, taglineFit].filter(
    (size): size is number => size !== null,
  );
  const arcSize = fittedSizes.length > 0
    ? Math.min(...fittedSizes)
    : MIN_ARC_SIZE;
  const arcTracking = tracking(arcSize, recipe.trackingPerMille);

  if (brandFit !== null) {
    const topPathId = builder.addPath({
      role: "top-arc",
      name: "Top text path",
      x: 0,
      y: 0,
      width: 600,
      height: 600,
      fill: "none",
      visible: false,
      d: "M 136 240 A 182 182 0 0 1 464 240",
      intrinsicWidth: 600,
      intrinsicHeight: 600,
    });
    builder.addText({
      role: "brand-arc",
      name: "Brand name on arc",
      x: 72,
      y: 106,
      width: 456,
      height: 160,
      fill: palette.ink,
      content: brand,
      ...supportingStyle(fonts),
      fontSize: arcSize,
      letterSpacing: arcTracking,
      align: "left",
      onPath: {
        pathId: topPathId,
        startOffset: arcStartOffset(
          brand,
          arcFontFamily,
          arcSize,
          arcTracking,
        ),
        flip: false,
      },
    });
  }

  if (tagline && taglineFit !== null) {
    const bottomPathId = builder.addPath({
      role: "bottom-arc",
      name: "Bottom text path",
      x: 0,
      y: 0,
      width: 600,
      height: 600,
      fill: "none",
      visible: false,
      d: "M 136 360 A 182 182 0 0 0 464 360",
      intrinsicWidth: 600,
      intrinsicHeight: 600,
    });
    builder.addText({
      role: "tagline-arc",
      name: "Tagline on arc",
      x: 72,
      y: 340,
      width: 456,
      height: 160,
      fill: palette.ink,
      content: tagline,
      ...supportingStyle(fonts),
      fontSize: arcSize,
      letterSpacing: arcTracking,
      align: "left",
      onPath: {
        pathId: bottomPathId,
        startOffset: arcStartOffset(
          tagline,
          arcFontFamily,
          arcSize,
          arcTracking,
        ),
        flip: false,
      },
    });
  }

  if (brandFit !== null || taglineFit !== null) {
    const separator = motifById(recipe.motifIds[0] ?? "diamond");
    const separatorSize = recipe.id === "seal-modern" ? 18 : 16;
    for (const x of [96, 600 - 96 - separatorSize]) {
      builder.addMotif(separator, {
        role: "separator",
        name: "Arc separator",
        x,
        y: 300 - separatorSize / 2,
        width: separatorSize,
        height: separatorSize,
        fill: palette.accent,
      });
    }
  }

  const mark = initials(context.brandName);
  const nominalMarkSize = recipe.id === "seal-trade" ? 122 : 116;
  const markSize = mark.length > 1
    ? Math.round(nominalMarkSize * 0.88)
    : nominalMarkSize;
  builder.addText({
    role: "monogram",
    name: "Center monogram",
    x: 190,
    y: Math.round(300 - markSize / 2),
    width: 220,
    height: markSize * 1.08,
    fill: palette.accent,
    content: mark,
    ...displayStyle(fonts),
    fontSize: markSize,
    letterSpacing: tracking(markSize, 60),
    align: "center",
  });
}
