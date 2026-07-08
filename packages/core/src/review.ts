import { getActiveArtboard, getNodesForArtboard } from "./queries";
import type { LogoDocument, LogoNode, Paint } from "./types";

/**
 * Deterministic "design mate" review pass. Pure heuristics, runs locally.
 * This is the seed of the agent tool surface — a future LLM-backed agent
 * consumes the same findings shape.
 */

export type ReviewFinding = {
  severity: "info" | "warning" | "strong";
  title: string;
  detail: string;
  action: string;
};

export type DesignReview = {
  summary: string;
  findings: ReviewFinding[];
};

function paintColor(paint: Paint): string {
  if (paint.type === "solid") {
    return paint.color;
  }
  return paint.stops[0]?.color ?? "#000000";
}

function luminance(hex: string): number {
  const normalized = hex.replace("#", "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized;
  const channels = [0, 2, 4].map(
    (offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255,
  );
  const [r = 0, g = 0, b = 0] = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const lighter = Math.max(luminance(a), luminance(b));
  const darker = Math.min(luminance(a), luminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

function reviewScale(nodes: LogoNode[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const smallDetails = nodes.filter(
    (node) => Math.min(node.width, node.height) < 16,
  );

  if (smallDetails.length > 0) {
    findings.push({
      severity: "warning",
      title: "Tiny details may fail at favicon size",
      detail: `${smallDetails.length} visible object${
        smallDetails.length === 1 ? "" : "s"
      } fall below 16px in one dimension.`,
      action: "Simplify or enlarge those details before exporting small icons.",
    });
  }

  return findings;
}

function reviewTypography(nodes: LogoNode[]): ReviewFinding[] {
  const textNodes = nodes.filter((node) => node.type === "text");
  const findings: ReviewFinding[] = [];

  for (const node of textNodes) {
    if (node.content.length > 14 && node.fontSize > 42) {
      findings.push({
        severity: "info",
        title: "Long wordmark needs spacing review",
        detail: `"${node.content}" is long enough that tracking and optical spacing will matter.`,
        action:
          "Check tight pairs manually, then preview the wordmark around 180px wide.",
      });
    }

    if (node.letterSpacing === 0 && node.fontWeight >= 700) {
      findings.push({
        severity: "info",
        title: "Heavy type may benefit from optical tracking",
        detail:
          "Bold wordmarks often need slightly negative or pair-specific spacing.",
        action:
          "Try tightening broad uppercase pairs and loosening cramped lowercase joins.",
      });
    }
  }

  if (textNodes.length === 0) {
    findings.push({
      severity: "info",
      title: "No wordmark yet",
      detail:
        "A logo system usually needs at least an icon-only and wordmark/horizontal version.",
      action: "Add a text object when you are ready to test logo lockups.",
    });
  }

  return findings;
}

function reviewContrast(
  document: LogoDocument,
  nodes: LogoNode[],
): ReviewFinding[] {
  const artboard = getActiveArtboard(document);
  const findings: ReviewFinding[] = [];

  for (const node of nodes) {
    const ratio = contrastRatio(paintColor(node.fill), artboard.background);

    if (ratio < 2.6 && node.opacity > 0.5) {
      findings.push({
        severity: "warning",
        title: "Low contrast against current background",
        detail: `${node.name} has a contrast ratio near ${ratio.toFixed(
          1,
        )}:1 against the artboard background.`,
        action:
          "Test a darker fill, lighter background, or create a reversed dark-mode variant.",
      });
    }
  }

  return findings;
}

function reviewLogoSystem(document: LogoDocument): ReviewFinding[] {
  const purposes = new Set(
    document.artboards.map((artboard) => artboard.purpose),
  );
  const findings: ReviewFinding[] = [];

  if (!purposes.has("icon")) {
    findings.push({
      severity: "info",
      title: "Icon-only variant is missing",
      detail: "The current file only has a primary lockup.",
      action:
        "Duplicate the primary artboard into an icon variant and simplify it for square use.",
    });
  }

  if (!purposes.has("wordmark")) {
    findings.push({
      severity: "info",
      title: "Wordmark variant is missing",
      detail:
        "A standalone wordmark is useful for wide placements and brand systems.",
      action: "Create a wordmark artboard once the typography direction is stable.",
    });
  }

  return findings;
}

export function analyzeLogoDocument(document: LogoDocument): DesignReview {
  const activeNodes = getNodesForArtboard(document);
  const visibleNodes = activeNodes.filter((node) => node.visible);
  const findings = [
    ...reviewScale(visibleNodes),
    ...reviewTypography(visibleNodes),
    ...reviewContrast(document, visibleNodes),
    ...reviewLogoSystem(document),
  ];

  if (visibleNodes.length > 8) {
    findings.push({
      severity: "warning",
      title: "Logo is getting visually complex",
      detail: `${visibleNodes.length} visible objects are present on the active artboard.`,
      action:
        "Try a monochrome pass and remove any shape that does not survive small-size preview.",
    });
  }

  return {
    summary:
      findings.length === 0
        ? "The active logo has a clean starting structure. Keep refining spacing, scale, and variants."
        : "I reviewed the active artboard like a production-minded design mate.",
    findings,
  };
}
