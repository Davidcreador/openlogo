import type {
  EllipseNode,
  LogoNode,
  PathNode,
  RectangleNode,
  TextNode,
  TextPathAttachment,
} from "@openlogo/core";
import type { Prng } from "../prng";
import type { FoundryRecipe } from "../recipes";
import type { FontPairing, FoundryPalette, Motif, Vibe } from "../types";

type BaseOptions = {
  role: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  rotation?: number;
  stroke?: { color: string; width: number };
  visible?: boolean;
};

export type TextOptions = BaseOptions & {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontStyle?: "normal" | "italic";
  letterSpacing?: number;
  lineHeight?: number;
  align?: "left" | "center" | "right";
  onPath?: TextPathAttachment;
};

export type PathOptions = BaseOptions & {
  d: string;
  intrinsicWidth: number;
  intrinsicHeight: number;
};

export class NodeBuilder {
  readonly nodes: Record<string, LogoNode> = {};
  readonly nodeIds: string[] = [];
  private readonly roleCounts = new Map<string, number>();

  constructor(private readonly prefix: string) {}

  id(role: string): string {
    const slug = role.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const count = this.roleCounts.get(slug) ?? 0;
    this.roleCounts.set(slug, count + 1);
    return `${this.prefix}-${slug}${count === 0 ? "" : `-${count + 1}`}`;
  }

  addRectangle(options: BaseOptions & { cornerRadius?: number }): string {
    const node: RectangleNode = {
      ...this.base(options),
      type: "rectangle",
      cornerRadius: options.cornerRadius ?? 0,
    };
    return this.add(node);
  }

  addEllipse(options: BaseOptions): string {
    const node: EllipseNode = { ...this.base(options), type: "ellipse" };
    return this.add(node);
  }

  addPath(options: PathOptions): string {
    const node: PathNode = {
      ...this.base(options),
      type: "path",
      d: options.d,
      intrinsicWidth: options.intrinsicWidth,
      intrinsicHeight: options.intrinsicHeight,
      fillRule: "nonzero",
    };
    return this.add(node);
  }

  addMotif(
    motif: Motif,
    options: Omit<BaseOptions, "name"> & { name?: string },
  ): string {
    return this.addPath({
      ...options,
      name: options.name ?? motif.name,
      d: motif.d,
      intrinsicWidth: motif.viewBox.width,
      intrinsicHeight: motif.viewBox.height,
    });
  }

  addText(options: TextOptions): string {
    const node: TextNode = {
      ...this.base(options),
      type: "text",
      content: options.content,
      fontFamily: options.fontFamily,
      fontSize: options.fontSize,
      fontWeight: options.fontWeight,
      ...(options.fontStyle ? { fontStyle: options.fontStyle } : {}),
      letterSpacing: options.letterSpacing ?? 0,
      lineHeight: options.lineHeight ?? 1.1,
      align: options.align ?? "left",
      ...(options.onPath ? { onPath: options.onPath } : {}),
    };
    return this.add(node);
  }

  private base(options: BaseOptions) {
    return {
      id: this.id(options.role),
      name: options.name,
      x: options.x,
      y: options.y,
      width: Math.max(1, options.width),
      height: Math.max(1, options.height),
      rotation: options.rotation ?? 0,
      opacity: 1,
      visible: options.visible ?? true,
      locked: false,
      fill: { type: "solid" as const, color: options.fill },
      ...(options.stroke
        ? {
            stroke: {
              color: options.stroke.color,
              width: options.stroke.width,
              align: "center" as const,
            },
          }
        : {}),
    };
  }

  private add<T extends LogoNode>(node: T): string {
    this.nodes[node.id] = node;
    this.nodeIds.push(node.id);
    return node.id;
  }
}

export type RecipeContext = {
  brandName: string;
  tagline?: string;
  vibe: Vibe;
  palette: FoundryPalette;
  fonts: FontPairing;
  recipe: FoundryRecipe;
  random: Prng;
  builder: NodeBuilder;
};

export function displayStyle(fonts: FontPairing) {
  return {
    fontFamily: fonts.display.family,
    fontWeight: fonts.display.weight,
    ...(fonts.display.style ? { fontStyle: fonts.display.style } : {}),
  };
}

export function supportingStyle(fonts: FontPairing) {
  return {
    fontFamily: fonts.supporting.family,
    fontWeight: fonts.supporting.weight,
    ...(fonts.supporting.style ? { fontStyle: fonts.supporting.style } : {}),
  };
}

export function fitFontSize(
  content: string,
  width: number,
  min: number,
  max: number,
  widthFactor = 0.58,
  trackingEm = 0,
): number {
  const glyphs = Math.max(1, Array.from(content).length);
  const fitted = width /
    (glyphs * widthFactor + Math.max(0, glyphs - 1) * trackingEm);
  return Math.round(fitted < min ? Math.max(10, fitted) : Math.min(max, fitted));
}

export function initials(brandName: string): string {
  const letters = brandName
    .trim()
    .split(/\s+/)
    .map((word) => word.match(/[\p{L}\p{N}]/u)?.[0])
    .filter((letter): letter is string => letter !== undefined)
    .slice(0, 2);
  return (letters.join("") || "B").toLocaleUpperCase();
}

export function displayBrand(context: RecipeContext): string {
  return context.recipe.brandCase === "uppercase"
    ? context.brandName.toLocaleUpperCase()
    : context.brandName;
}

export function tracking(fontSize: number, perMille: number): number {
  return Math.round((fontSize * perMille) / 10) / 100;
}

export function jitter(random: Prng, value: number, radius = 2): number {
  return value + random.int(-radius, radius);
}

export function balancedLineBreak(content: string, threshold = 16): string {
  if (Array.from(content).length <= threshold) {
    return content;
  }
  const words = content.split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    return content;
  }

  let bestIndex = 1;
  let bestDifference = Number.POSITIVE_INFINITY;
  for (let index = 1; index < words.length; index += 1) {
    const left = words.slice(0, index).join(" ").length;
    const right = words.slice(index).join(" ").length;
    const difference = Math.abs(left - right);
    if (difference < bestDifference) {
      bestIndex = index;
      bestDifference = difference;
    }
  }
  return `${words.slice(0, bestIndex).join(" ")}\n${words
    .slice(bestIndex)
    .join(" ")}`;
}

export function addRule(
  builder: NodeBuilder,
  role: string,
  x: number,
  y: number,
  width: number,
  color: string,
  thickness: number,
): string {
  return builder.addRectangle({
    role,
    name: "Rule",
    x,
    y,
    width,
    height: thickness,
    fill: color,
  });
}
