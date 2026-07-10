import {
  collectLeafNodeIds,
  getActiveArtboard,
  getRenderNodesForArtboard,
  visualBounds,
} from "./queries";
import type { Artboard, LogoDocument, LogoNode, Paint } from "./types";

/**
 * Deterministic "design mate" review pass. Pure heuristics, runs locally.
 * This is the seed of the agent tool surface — a future LLM-backed agent
 * consumes the same findings shape.
 */

export type ReviewCategory =
  | "concept"
  | "composition"
  | "typography"
  | "geometry"
  | "color"
  | "scalability"
  | "variants"
  | "production";

export type ReviewEvidence = {
  label: string;
  value: string | number;
  unit?: string;
};

export type ReviewSuggestedAction = {
  id: string;
  label: string;
};

export type ReviewKind = "objective" | "judgment";

export type ReviewFinding = {
  id: string;
  severity: "info" | "warning" | "strong";
  category: ReviewCategory;
  kind: ReviewKind;
  title: string;
  detail: string;
  action: string;
  nodeIds?: string[];
  artboardId?: string;
  evidence: ReviewEvidence[];
  suggestedActions: ReviewSuggestedAction[];
};

export type DesignReview = {
  summary: string;
  findings: ReviewFinding[];
};

export type ReviewScope = "selection" | "active-artboard" | "document";

export type AnalyzeLogoOptions = {
  scope?: ReviewScope;
  selectionIds?: readonly string[];
};

const findingId = (rule: string, ...references: string[]): string =>
  [rule, ...references.map((reference) => encodeURIComponent(reference))].join(
    ":",
  );

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

export const LOGO_REVIEW_CONTRAST_THRESHOLD = 2.6;

/** Contrast calculation shared by review findings and safe proposal binding. */
export function logoColorContrastRatio(a: string, b: string): number {
  const lighter = Math.max(luminance(a), luminance(b));
  const darker = Math.min(luminance(a), luminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

function reviewScale(
  nodes: LogoNode[],
  artboardId: string,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const smallDetails = nodes.filter(
    (node) => Math.min(node.width, node.height) < 16,
  );

  if (smallDetails.length > 0) {
    const action =
      "Simplify or enlarge those details before exporting small icons.";
    findings.push({
      id: findingId("scalability.tiny-details", artboardId),
      severity: "warning",
      category: "scalability",
      kind: "objective",
      title: "Tiny details may fail at favicon size",
      detail: `${smallDetails.length} visible object${
        smallDetails.length === 1 ? "" : "s"
      } fall below 16px in one dimension.`,
      action,
      nodeIds: smallDetails.map((node) => node.id),
      artboardId,
      evidence: [
        { label: "Objects below threshold", value: smallDetails.length },
        { label: "Detail-size threshold", value: 16, unit: "px" },
      ],
      suggestedActions: [{ id: "simplify-small-details", label: action }],
    });
  }

  return findings;
}

function reviewTypography(
  nodes: LogoNode[],
  artboardId: string,
  includeAbsenceFinding: boolean,
): ReviewFinding[] {
  const textNodes = nodes.filter((node) => node.type === "text");
  const findings: ReviewFinding[] = [];

  for (const node of textNodes) {
    if (node.content.length > 14 && node.fontSize > 42) {
      const action =
        "Check tight pairs manually, then preview the wordmark around 180px wide.";
      findings.push({
        id: findingId("typography.long-wordmark", artboardId, node.id),
        severity: "info",
        category: "typography",
        kind: "judgment",
        title: "Long wordmark needs spacing review",
        detail: `"${node.content}" is long enough that tracking and optical spacing will matter.`,
        action,
        nodeIds: [node.id],
        artboardId,
        evidence: [
          { label: "Character count", value: node.content.length },
          { label: "Font size", value: node.fontSize, unit: "px" },
        ],
        suggestedActions: [{ id: "review-wordmark-spacing", label: action }],
      });
    }

    if (node.letterSpacing === 0 && node.fontWeight >= 700) {
      const action =
        "Try tightening broad uppercase pairs and loosening cramped lowercase joins.";
      findings.push({
        id: findingId("typography.heavy-tracking", artboardId, node.id),
        severity: "info",
        category: "typography",
        kind: "judgment",
        title: "Heavy type may benefit from optical tracking",
        detail:
          "Bold wordmarks often need slightly negative or pair-specific spacing.",
        action,
        nodeIds: [node.id],
        artboardId,
        evidence: [
          { label: "Font weight", value: node.fontWeight },
          { label: "Letter spacing", value: node.letterSpacing, unit: "px" },
        ],
        suggestedActions: [{ id: "adjust-optical-tracking", label: action }],
      });
    }
  }

  if (includeAbsenceFinding && textNodes.length === 0) {
    const action = "Add a text object when you are ready to test logo lockups.";
    findings.push({
      id: findingId("typography.no-wordmark", artboardId),
      severity: "info",
      category: "typography",
      kind: "objective",
      title: "No wordmark yet",
      detail:
        "A logo system usually needs at least an icon-only and wordmark/horizontal version.",
      action,
      artboardId,
      evidence: [{ label: "Visible text objects", value: 0 }],
      suggestedActions: [{ id: "add-wordmark", label: action }],
    });
  }

  return findings;
}

function reviewContrast(
  artboard: Artboard,
  nodes: LogoNode[],
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  for (const node of nodes) {
    const foreground = paintColor(node.fill);
    const ratio = logoColorContrastRatio(foreground, artboard.background);

    if (ratio < LOGO_REVIEW_CONTRAST_THRESHOLD && node.opacity > 0.5) {
      const action =
        "Test a darker fill, lighter background, or create a reversed dark-mode variant.";
      findings.push({
        id: findingId("color.low-contrast", artboard.id, node.id),
        severity: "warning",
        category: "color",
        kind: "objective",
        title: "Low contrast against current background",
        detail: `${node.name} has a contrast ratio near ${ratio.toFixed(
          1,
        )}:1 against the artboard background.`,
        action,
        nodeIds: [node.id],
        artboardId: artboard.id,
        evidence: [
          { label: "Contrast ratio", value: Number(ratio.toFixed(2)) },
          { label: "Foreground", value: foreground },
          { label: "Background", value: artboard.background },
        ],
        suggestedActions: [{ id: "increase-color-contrast", label: action }],
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

  const variants = [
    {
      purpose: "icon",
      title: "Icon-only variant is missing",
      detail:
        "A simplified square mark is needed for favicons, avatars, and compact placements.",
      action:
        "Duplicate the primary artboard into an icon variant and simplify it for square use.",
    },
    {
      purpose: "wordmark",
      title: "Wordmark variant is missing",
      detail:
        "A standalone wordmark is useful for wide placements and brand systems.",
      action:
        "Create a wordmark artboard once the typography direction is stable.",
    },
    {
      purpose: "horizontal",
      title: "Horizontal lockup is missing",
      detail:
        "A horizontal lockup gives the logo system a practical option for navigation bars and narrow placements.",
      action:
        "Create a horizontal variant and refine the mark-to-wordmark spacing for wide use.",
    },
    {
      purpose: "stacked",
      title: "Stacked lockup is missing",
      detail:
        "A stacked lockup provides a compact alternative when a square footprint has more room than an icon alone.",
      action:
        "Create a stacked variant and refine its vertical spacing for compact placements.",
    },
  ] as const;

  for (const variant of variants) {
    if (purposes.has(variant.purpose)) {
      continue;
    }
    findings.push({
      id: `variants.missing-${variant.purpose}`,
      severity: "info",
      category: "variants",
      kind: "objective",
      title: variant.title,
      detail: variant.detail,
      action: variant.action,
      evidence: [
        {
          label: `${variant.purpose[0]!.toUpperCase()}${variant.purpose.slice(1)} artboards`,
          value: 0,
        },
        { label: "Total artboards", value: document.artboards.length },
      ],
      suggestedActions: [
        {
          id: `create-${variant.purpose}-variant`,
          label: variant.action,
        },
      ],
    });
  }

  return findings;
}

type ReviewContext = {
  artboard: Artboard;
  nodes: LogoNode[];
  units: LogoNode[];
};

function reviewGeometry(
  document: LogoDocument,
  context: ReviewContext,
): ReviewFinding[] {
  const candidates = context.units.filter(
    (node) => node.visible && !node.locked && node.opacity >= 0.5,
  );
  if (candidates.length !== 2) {
    return [];
  }
  const [left, right] = [...candidates].sort((first, second) => {
    const firstBounds = visualBounds(document, first.id);
    const secondBounds = visualBounds(document, second.id);
    return (firstBounds?.x ?? first.x) - (secondBounds?.x ?? second.x);
  });
  if (!left || !right) {
    return [];
  }
  const leftBounds = visualBounds(document, left.id);
  const rightBounds = visualBounds(document, right.id);
  if (!leftBounds || !rightBounds) {
    return [];
  }
  const horizontalGap = rightBounds.x - (leftBounds.x + leftBounds.width);
  const centerDelta = Math.abs(
    leftBounds.y +
      leftBounds.height / 2 -
      (rightBounds.y + rightBounds.height / 2),
  );
  const tolerance = Math.max(
    2,
    Math.min(leftBounds.height, rightBounds.height) * 0.08,
  );
  if (horizontalGap < 0 || centerDelta <= tolerance) {
    return [];
  }

  const action =
    "Preview a shared optical center line, then adjust by eye if the shapes carry different visual weight.";
  return [
    {
      id: findingId("geometry.horizontal-center-drift", context.artboard.id),
      severity: "info",
      category: "geometry",
      kind: "objective",
      title: "Horizontal lockup centers are drifting",
      detail: `The two primary units differ by ${centerDelta.toFixed(1)}px on their visual center line.`,
      action,
      nodeIds: [left.id, right.id],
      artboardId: context.artboard.id,
      evidence: [
        {
          label: "Visual center difference",
          value: Number(centerDelta.toFixed(2)),
          unit: "px",
        },
        {
          label: "Alignment tolerance",
          value: Number(tolerance.toFixed(2)),
          unit: "px",
        },
      ],
      suggestedActions: [{ id: "align-lockup-centers", label: action }],
    },
  ];
}

function reviewProduction(
  document: LogoDocument,
  context: ReviewContext,
): ReviewFinding[] {
  const overflowing = context.units.filter((node) => {
    if (!node.visible) {
      return false;
    }
    const bounds = visualBounds(document, node.id);
    return (
      bounds !== null &&
      (bounds.x < 0 ||
        bounds.y < 0 ||
        bounds.x + bounds.width > context.artboard.width ||
        bounds.y + bounds.height > context.artboard.height)
    );
  });
  if (overflowing.length === 0) {
    return [];
  }

  const action =
    "Bring the overflowing artwork inside the artboard before creating production exports.";
  return [
    {
      id: findingId("production.artwork-outside-artboard", context.artboard.id),
      severity: "warning",
      category: "production",
      kind: "objective",
      title: "Artwork extends beyond the export artboard",
      detail: `${overflowing.length} visible ${overflowing.length === 1 ? "object extends" : "objects extend"} outside the current export bounds.`,
      action,
      nodeIds: overflowing.map((node) => node.id),
      artboardId: context.artboard.id,
      evidence: [
        { label: "Overflowing objects", value: overflowing.length },
        {
          label: "Artboard size",
          value: `${context.artboard.width} × ${context.artboard.height}`,
          unit: "px",
        },
      ],
      suggestedActions: [{ id: "fit-artwork-to-artboard", label: action }],
    },
  ];
}

function normalizeBriefText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Deterministic brief checks stay deliberately factual. Semantic judgments
 * about attributes, competitors, or motifs belong to a model-backed provider,
 * but a visible wordmark can be checked safely against an explicit brand name.
 */
function reviewBriefAlignment(
  document: LogoDocument,
  contexts: readonly ReviewContext[],
  scope: ReviewScope,
): ReviewFinding[] {
  const brandName = document.designBrief?.brandName;
  if (!brandName || scope === "selection") {
    return [];
  }

  const textNodes = contexts
    .flatMap((context) => context.nodes)
    .filter((node) => node.type === "text");
  if (
    textNodes.length === 0 ||
    textNodes.some((node) =>
      normalizeBriefText(node.content).includes(normalizeBriefText(brandName)),
    )
  ) {
    return [];
  }

  const artboardId =
    scope === "active-artboard" ? contexts[0]?.artboard.id : undefined;
  const action =
    "Update the visible wordmark or confirm that this scope is intentionally symbol-only.";
  return [
    {
      id: findingId(
        "concept.brand-name-mismatch",
        ...(artboardId ? [artboardId] : []),
      ),
      severity: "info",
      category: "concept",
      kind: "objective",
      title: "Wordmark does not match the brand brief",
      detail: `"${brandName}" does not appear in the visible wordmark text for this scope.`,
      action,
      nodeIds: textNodes.map((node) => node.id),
      ...(artboardId ? { artboardId } : {}),
      evidence: [
        { label: "Brief brand name", value: brandName },
        { label: "Visible text objects", value: textNodes.length },
      ],
      suggestedActions: [{ id: "align-wordmark-with-brief", label: action }],
    },
  ];
}

function contextForArtboard(
  document: LogoDocument,
  artboard: Artboard,
): ReviewContext {
  return {
    artboard,
    // Flattened leaves so grouped shapes are reviewed individually.
    nodes: getRenderNodesForArtboard(document, artboard.id).filter(
      (node) => node.visible,
    ),
    units: artboard.nodeIds.flatMap((nodeId) => {
      const node = document.nodes[nodeId];
      return node ? [node] : [];
    }),
  };
}

function resolveReviewScope(
  document: LogoDocument,
  options: AnalyzeLogoOptions,
): { scope: ReviewScope; contexts: ReviewContext[] } {
  const requestedScope = options.scope ?? "active-artboard";
  if (requestedScope === "document") {
    return {
      scope: "document",
      contexts: document.artboards.map((artboard) =>
        contextForArtboard(document, artboard),
      ),
    };
  }

  const activeContext = () =>
    contextForArtboard(document, getActiveArtboard(document));
  if (requestedScope !== "selection") {
    return { scope: "active-artboard", contexts: [activeContext()] };
  }

  const leafArtboards = new Map<string, string>();
  for (const artboard of document.artboards) {
    for (const nodeId of collectLeafNodeIds(document, artboard.nodeIds)) {
      if (!leafArtboards.has(nodeId)) {
        leafArtboards.set(nodeId, artboard.id);
      }
    }
  }

  const selectedLeafIds = new Set(
    collectLeafNodeIds(document, options.selectionIds ?? []).filter((nodeId) =>
      leafArtboards.has(nodeId),
    ),
  );
  if (selectedLeafIds.size === 0) {
    return { scope: "active-artboard", contexts: [activeContext()] };
  }

  const contexts: ReviewContext[] = [];
  for (const artboard of document.artboards) {
    const hasSelectedLeaf = [...selectedLeafIds].some(
      (nodeId) => leafArtboards.get(nodeId) === artboard.id,
    );
    if (!hasSelectedLeaf) {
      continue;
    }
    contexts.push({
      artboard,
      nodes: getRenderNodesForArtboard(document, artboard.id).filter(
        (node) => selectedLeafIds.has(node.id) && node.visible,
      ),
      units: getRenderNodesForArtboard(document, artboard.id).filter(
        (node) => selectedLeafIds.has(node.id) && node.visible,
      ),
    });
  }

  return { scope: "selection", contexts };
}

function reviewComplexity(
  nodes: LogoNode[],
  artboard: Artboard,
  isActiveArtboard: boolean,
): ReviewFinding[] {
  if (nodes.length <= 8) {
    return [];
  }

  const action =
    "Try a monochrome pass and remove any shape that does not survive small-size preview.";
  return [
    {
      id: findingId("composition.visual-complexity", artboard.id),
      severity: "warning",
      category: "composition",
      kind: "judgment",
      title: "Logo is getting visually complex",
      detail: `${nodes.length} visible objects are present on ${
        isActiveArtboard ? "the active artboard" : `"${artboard.name}"`
      }.`,
      action,
      nodeIds: nodes.map((node) => node.id),
      artboardId: artboard.id,
      evidence: [
        { label: "Visible objects", value: nodes.length },
        { label: "Complexity threshold", value: 8 },
      ],
      suggestedActions: [{ id: "simplify-composition", label: action }],
    },
  ];
}

export function analyzeLogoDocument(
  document: LogoDocument,
  options: AnalyzeLogoOptions = {},
): DesignReview {
  const review = resolveReviewScope(document, options);
  const includeArtboardAbsenceFindings = review.scope !== "selection";
  const findings: ReviewFinding[] = [];

  for (const context of review.contexts) {
    findings.push(
      ...reviewScale(context.nodes, context.artboard.id),
      ...reviewTypography(
        context.nodes,
        context.artboard.id,
        includeArtboardAbsenceFindings,
      ),
      ...reviewContrast(context.artboard, context.nodes),
      ...reviewGeometry(document, context),
      ...reviewProduction(document, context),
    );
  }
  findings.push(
    ...reviewBriefAlignment(document, review.contexts, review.scope),
  );

  // Variant coverage describes the whole file, never a selected subset.
  if (review.scope !== "selection") {
    findings.push(...reviewLogoSystem(document));
  }
  for (const context of review.contexts) {
    findings.push(
      ...reviewComplexity(
        context.nodes,
        context.artboard,
        context.artboard.id === document.activeArtboardId,
      ),
    );
  }

  const cleanSummary =
    review.scope === "selection"
      ? "The selected logo elements have a clean starting structure."
      : review.scope === "document"
        ? "The logo system has a clean starting structure across its artboards."
        : "The active logo has a clean starting structure. Keep refining spacing, scale, and variants.";
  const findingsSummary =
    review.scope === "selection"
      ? "I reviewed the selected logo elements like a production-minded design mate."
      : review.scope === "document"
        ? "I reviewed every artboard like a production-minded design mate."
        : "I reviewed the active artboard like a production-minded design mate.";

  const summary = findings.length === 0 ? cleanSummary : findingsSummary;
  const brandName = document.designBrief?.brandName;
  return {
    summary: brandName
      ? `For ${brandName}, ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`
      : summary,
    findings,
  };
}
