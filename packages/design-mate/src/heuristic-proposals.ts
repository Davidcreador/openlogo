import {
  collectLeafNodeIds,
  getRenderNodesForArtboard,
  LOGO_REVIEW_CONTRAST_THRESHOLD,
  logoColorContrastRatio,
  visualBounds,
} from "@openlogo/core";
import type {
  Artboard,
  LogoDocument,
  LogoNode,
  LogoVariant,
  ReviewFinding,
  ReviewScope,
  SolidPaint,
  TextNode,
} from "@openlogo/core";
import type {
  DesignMateAction,
  DesignMateProposal,
  DesignMateRisk,
} from "./contracts";
import {
  DESIGN_MATE_PROPOSAL_LIMITS,
  isValidDesignMateSolidColor,
  normalizeDesignMateSolidColor,
} from "./proposal-validation";

type SupportedFindingAction =
  | "align-wordmark-with-brief"
  | "add-wordmark"
  | "adjust-optical-tracking"
  | "align-lockup-centers"
  | "simplify-small-details"
  | "increase-color-contrast"
  | "create-icon-variant"
  | "create-wordmark-variant"
  | "create-horizontal-variant"
  | "create-stacked-variant";

type SolidLeafNode = Exclude<LogoNode, { type: "group" }> & {
  readonly fill: SolidPaint;
};

const SUPPORTED_FINDING_ACTIONS: readonly SupportedFindingAction[] = [
  "align-wordmark-with-brief",
  "add-wordmark",
  "adjust-optical-tracking",
  "align-lockup-centers",
  "simplify-small-details",
  "increase-color-contrast",
  "create-icon-variant",
  "create-wordmark-variant",
  "create-horizontal-variant",
  "create-stacked-variant",
];

function variantPurposeForAction(
  actionId: SupportedFindingAction,
): Exclude<LogoVariant, "primary"> | null {
  switch (actionId) {
    case "create-icon-variant":
      return "icon";
    case "create-wordmark-variant":
      return "wordmark";
    case "create-horizontal-variant":
      return "horizontal";
    case "create-stacked-variant":
      return "stacked";
    default:
      return null;
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function proposalId(
  actionId: SupportedFindingAction,
  findingId: string,
  target: string,
): string {
  return `heuristic:${actionId}:${hashText(`${findingId}\u0000${target}`)}`;
}

function normalizeBriefText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function findingCanBeReferenced(finding: ReviewFinding): boolean {
  return (
    finding.id.trim().length > 0 &&
    finding.id.length <= DESIGN_MATE_PROPOSAL_LIMITS.referenceIdLength
  );
}

function hasSuggestedAction(
  finding: ReviewFinding,
  actionId: SupportedFindingAction,
): boolean {
  return finding.suggestedActions.some((action) => action.id === actionId);
}

function artboardsForFinding(
  document: LogoDocument,
  finding: ReviewFinding,
  scope: ReviewScope,
): Artboard[] {
  if (finding.artboardId !== undefined) {
    if (
      scope === "active-artboard" &&
      finding.artboardId !== document.activeArtboardId
    ) {
      return [];
    }
    const artboard = document.artboards.find(
      (candidate) => candidate.id === finding.artboardId,
    );
    return artboard ? [artboard] : [];
  }
  if (scope === "active-artboard") {
    const active = document.artboards.find(
      (artboard) => artboard.id === document.activeArtboardId,
    );
    return active ? [active] : [];
  }
  return scope === "document" ? [...document.artboards] : [];
}

function effectiveNodes(
  document: LogoDocument,
  artboards: readonly Artboard[],
): Map<string, LogoNode> {
  const nodes = new Map<string, LogoNode>();
  for (const artboard of artboards) {
    for (const node of getRenderNodesForArtboard(document, artboard.id)) {
      if (node.visible && !nodes.has(node.id)) {
        nodes.set(node.id, node);
      }
    }
  }
  return nodes;
}

function makeProposal(
  finding: ReviewFinding,
  actionId: SupportedFindingAction,
  target: string,
  label: string,
  rationale: string,
  risk: DesignMateRisk,
  action: DesignMateAction,
): DesignMateProposal {
  return {
    id: proposalId(actionId, finding.id, target),
    label,
    rationale,
    risk,
    sourceFindingIds: [finding.id],
    actions: [action],
  };
}

function buildBriefAlignmentProposal(
  document: LogoDocument,
  finding: ReviewFinding,
  scope: ReviewScope,
): DesignMateProposal | null {
  if (
    scope === "selection" ||
    finding.kind !== "objective" ||
    finding.category !== "concept"
  ) {
    return null;
  }
  const brandName = document.designBrief?.brandName;
  if (
    !brandName ||
    brandName.trim().length === 0 ||
    brandName.length > DESIGN_MATE_PROPOSAL_LIMITS.textContentLength
  ) {
    return null;
  }

  const references = [...new Set(finding.nodeIds ?? [])];
  if (references.length === 0) {
    return null;
  }
  const rendered = effectiveNodes(
    document,
    artboardsForFinding(document, finding, scope),
  );
  const visibleTextNodes = references
    .map((nodeId) => rendered.get(nodeId))
    .filter((node): node is TextNode => node?.type === "text");
  const normalizedBrandName = normalizeBriefText(brandName);
  if (
    visibleTextNodes.length === 0 ||
    visibleTextNodes.some((node) =>
      normalizeBriefText(node.content).includes(normalizedBrandName),
    )
  ) {
    return null;
  }

  const candidates = visibleTextNodes.filter(
    (node) => !node.locked && Number.isFinite(node.fontSize),
  );
  if (candidates.length === 0) {
    return null;
  }
  const largestFontSize = Math.max(...candidates.map((node) => node.fontSize));
  const largest = candidates.filter(
    (node) => node.fontSize === largestFontSize,
  );
  if (largest.length !== 1) {
    return null;
  }
  const target = largest[0]!;
  if (target.content === brandName) {
    return null;
  }

  return makeProposal(
    finding,
    "align-wordmark-with-brief",
    target.id,
    "Use brand name from brief",
    "Uses the explicit brand name from the design brief on the single primary visible text node.",
    "low",
    {
      type: "set-text-content",
      nodeId: target.id,
      content: brandName,
    },
  );
}

function buildWordmarkProposal(
  document: LogoDocument,
  finding: ReviewFinding,
  scope: ReviewScope,
): DesignMateProposal | null {
  const brandName = document.designBrief?.brandName?.trim();
  const [artboard] = artboardsForFinding(document, finding, scope);
  if (
    scope === "selection" ||
    finding.kind !== "objective" ||
    finding.category !== "typography" ||
    !brandName ||
    brandName.length > DESIGN_MATE_PROPOSAL_LIMITS.textContentLength ||
    !artboard
  ) {
    return null;
  }
  const rendered = effectiveNodes(document, [artboard]);
  if (
    [...rendered.values()].some(
      (node) => node.type === "text" && node.content.trim().length > 0,
    )
  ) {
    return null;
  }

  return makeProposal(
    finding,
    "add-wordmark",
    `${artboard.id}:${brandName}`,
    "Add wordmark from brand brief",
    "Creates one editable, centered wordmark using the explicit brand name without changing the existing mark.",
    "medium",
    {
      type: "create-wordmark",
      artboardId: artboard.id,
      content: brandName,
    },
  );
}

function buildTrackingProposal(
  document: LogoDocument,
  finding: ReviewFinding,
  scope: ReviewScope,
): DesignMateProposal | null {
  if (finding.category !== "typography") {
    return null;
  }
  const rendered = effectiveNodes(
    document,
    artboardsForFinding(document, finding, scope),
  );
  const candidates = [...new Set(finding.nodeIds ?? [])]
    .map((nodeId) => rendered.get(nodeId))
    .filter(
      (node): node is TextNode =>
        node?.type === "text" &&
        !node.locked &&
        node.letterSpacing === 0 &&
        node.fontWeight >= 700,
    );
  if (candidates.length !== 1) {
    return null;
  }
  const target = candidates[0]!;
  const letterSpacing = Number(
    (-Math.min(2, Math.max(0.5, target.fontSize * 0.02))).toFixed(2),
  );

  return makeProposal(
    finding,
    "adjust-optical-tracking",
    `${target.id}:${letterSpacing}`,
    "Try a tighter tracking pass",
    "Applies a conservative negative tracking starting point for preview; pair-specific optical corrections remain a manual decision.",
    "medium",
    {
      type: "set-letter-spacing",
      nodeId: target.id,
      letterSpacing,
    },
  );
}

function buildSmallDetailProposal(
  document: LogoDocument,
  finding: ReviewFinding,
  scope: ReviewScope,
): DesignMateProposal | null {
  if (
    finding.kind !== "objective" ||
    finding.category !== "scalability"
  ) {
    return null;
  }
  const rendered = effectiveNodes(
    document,
    artboardsForFinding(document, finding, scope),
  );
  const references = [...new Set(finding.nodeIds ?? [])];
  if (references.length !== 1) {
    return null;
  }
  const target = rendered.get(references[0]!);
  const bounds = target ? visualBounds(document, target.id) : null;
  if (!target || target.locked || !bounds) {
    return null;
  }
  const smallestDimension = Math.min(bounds.width, bounds.height);
  if (
    !Number.isFinite(smallestDimension) ||
    smallestDimension <= 0 ||
    smallestDimension >= 16
  ) {
    return null;
  }
  const scale = Number((16 / smallestDimension).toFixed(4));
  if (
    scale <= 1 ||
    scale > Math.min(4, DESIGN_MATE_PROPOSAL_LIMITS.maximumScale)
  ) {
    return null;
  }

  return makeProposal(
    finding,
    "simplify-small-details",
    `${target.id}:${scale}`,
    "Enlarge the small detail",
    "Only one small unlocked detail was found, so this previews a uniform enlargement to the 16px review threshold without deleting artwork.",
    "medium",
    {
      type: "scale-nodes",
      nodeIds: [target.id],
      scaleX: scale,
      scaleY: scale,
    },
  );
}

function buildAlignmentProposal(
  document: LogoDocument,
  finding: ReviewFinding,
  scope: ReviewScope,
): DesignMateProposal | null {
  const [artboard] = artboardsForFinding(document, finding, scope);
  const nodeIds = [...new Set(finding.nodeIds ?? [])];
  if (
    finding.kind !== "objective" ||
    finding.category !== "geometry" ||
    !artboard ||
    nodeIds.length !== 2 ||
    !nodeIds.every((nodeId) => artboard.nodeIds.includes(nodeId))
  ) {
    return null;
  }
  const rendered = effectiveNodes(document, [artboard]);
  if (
    nodeIds.some((nodeId) => {
      const node = rendered.get(nodeId);
      return !node || node.locked;
    })
  ) {
    return null;
  }

  return makeProposal(
    finding,
    "align-lockup-centers",
    nodeIds.join(":"),
    "Align lockup visual centers",
    "Aligns the two top-level lockup units to a shared visual center line while preserving their horizontal spacing.",
    "medium",
    {
      type: "align-nodes",
      nodeIds,
      edge: "centerY",
      reference: "selection",
      keyObjectId: null,
    },
  );
}

function contrastCandidates(document: LogoDocument): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const color of [
    ...document.palettes.flatMap((palette) => palette.colors),
    "#000000",
    "#ffffff",
  ]) {
    if (!isValidDesignMateSolidColor(color)) {
      continue;
    }
    const normalized = normalizeDesignMateSolidColor(color);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      candidates.push(normalized);
    }
  }
  return candidates;
}

function buildContrastProposal(
  document: LogoDocument,
  finding: ReviewFinding,
  scope: ReviewScope,
): DesignMateProposal | null {
  if (
    finding.kind !== "objective" ||
    finding.category !== "color" ||
    finding.artboardId === undefined
  ) {
    return null;
  }
  const [artboard] = artboardsForFinding(document, finding, scope);
  if (!artboard) {
    return null;
  }

  const rendered = effectiveNodes(document, [artboard]);
  const references = [...new Set(finding.nodeIds ?? [])];
  const candidates = references
    .map((nodeId) => rendered.get(nodeId))
    .filter(
      (node): node is SolidLeafNode =>
        node !== undefined &&
        node.type !== "group" &&
        !node.locked &&
        node.fill.type === "solid",
    );
  if (candidates.length !== 1) {
    return null;
  }
  const target = candidates[0]!;
  if (
    target.opacity <= 0.5 ||
    !isValidDesignMateSolidColor(target.fill.color) ||
    !isValidDesignMateSolidColor(artboard.background)
  ) {
    return null;
  }
  const currentColor = normalizeDesignMateSolidColor(target.fill.color);
  const background = normalizeDesignMateSolidColor(artboard.background);
  if (
    logoColorContrastRatio(currentColor, background) >=
    LOGO_REVIEW_CONTRAST_THRESHOLD
  ) {
    return null;
  }

  const replacement = contrastCandidates(document).find(
    (color) =>
      color !== currentColor &&
      logoColorContrastRatio(color, background) >=
        LOGO_REVIEW_CONTRAST_THRESHOLD,
  );
  if (!replacement) {
    return null;
  }

  return makeProposal(
    finding,
    "increase-color-contrast",
    `${target.id}:${replacement}`,
    "Increase color contrast",
    `Uses a deterministic palette color or neutral that meets the ${LOGO_REVIEW_CONTRAST_THRESHOLD}:1 review threshold.`,
    "medium",
    {
      type: "set-fill-color",
      nodeId: target.id,
      color: replacement,
    },
  );
}

function buildVariantProposal(
  document: LogoDocument,
  finding: ReviewFinding,
  scope: ReviewScope,
  purpose: Exclude<LogoVariant, "primary">,
): DesignMateProposal | null {
  if (
    scope === "selection" ||
    finding.kind !== "objective" ||
    finding.category !== "variants" ||
    document.artboards.length >= DESIGN_MATE_PROPOSAL_LIMITS.artboards ||
    document.artboards.some((artboard) => artboard.purpose === purpose)
  ) {
    return null;
  }

  const source =
    document.artboards.find((artboard) => artboard.purpose === "primary") ??
    document.artboards.find(
      (artboard) => artboard.id === document.activeArtboardId,
    );
  if (
    !source ||
    source.nodeIds.length === 0 ||
    collectLeafNodeIds(document, source.nodeIds).length === 0
  ) {
    return null;
  }

  const actionId = `create-${purpose}-variant` as SupportedFindingAction;
  return makeProposal(
    finding,
    actionId,
    `${source.id}:${purpose}`,
    `Create ${purpose} logo variant`,
    "Clones the primary artboard, or the active fallback, without changing existing artwork.",
    "low",
    {
      type: "create-logo-variant",
      sourceArtboardId: source.id,
      purpose,
    },
  );
}

/**
 * Bind factual findings and one conservative tracking preview to unambiguous,
 * currently valid mutations. Destructive simplification and open-ended visual
 * judgment remain chat/manual work.
 */
export function buildHeuristicDesignMateProposals(
  document: LogoDocument,
  findings: readonly ReviewFinding[],
  scope: ReviewScope,
): DesignMateProposal[] {
  const proposals: DesignMateProposal[] = [];
  const seenMutations = new Set<string>();
  const sortedFindings = [...findings].sort((left, right) =>
    compareStrings(left.id, right.id),
  );

  for (const finding of sortedFindings) {
    if (!findingCanBeReferenced(finding)) {
      continue;
    }
    for (const actionId of SUPPORTED_FINDING_ACTIONS) {
      if (!hasSuggestedAction(finding, actionId)) {
        continue;
      }

      let proposal: DesignMateProposal | null;
      if (actionId === "align-wordmark-with-brief") {
        proposal = buildBriefAlignmentProposal(document, finding, scope);
      } else if (actionId === "add-wordmark") {
        proposal = buildWordmarkProposal(document, finding, scope);
      } else if (actionId === "adjust-optical-tracking") {
        proposal = buildTrackingProposal(document, finding, scope);
      } else if (actionId === "align-lockup-centers") {
        proposal = buildAlignmentProposal(document, finding, scope);
      } else if (actionId === "simplify-small-details") {
        proposal = buildSmallDetailProposal(document, finding, scope);
      } else if (actionId === "increase-color-contrast") {
        proposal = buildContrastProposal(document, finding, scope);
      } else {
        const purpose = variantPurposeForAction(actionId);
        proposal = purpose
          ? buildVariantProposal(document, finding, scope, purpose)
          : null;
      }
      if (!proposal) {
        continue;
      }
      const mutationKey = JSON.stringify(proposal.actions);
      if (seenMutations.has(mutationKey)) {
        continue;
      }
      seenMutations.add(mutationKey);
      proposals.push(proposal);
    }
  }

  return proposals;
}
