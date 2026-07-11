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
  | "fit-artwork-to-artboard"
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
  "fit-artwork-to-artboard",
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

function makeMultiActionProposal(
  finding: ReviewFinding,
  actionId: SupportedFindingAction,
  target: string,
  label: string,
  rationale: string,
  risk: DesignMateRisk,
  actions: readonly DesignMateAction[],
): DesignMateProposal {
  return {
    id: proposalId(actionId, finding.id, target),
    label,
    rationale,
    risk,
    sourceFindingIds: [finding.id],
    actions: [...actions],
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

function buildFitArtworkProposal(
  document: LogoDocument,
  finding: ReviewFinding,
  scope: ReviewScope,
): DesignMateProposal | null {
  const [artboard] = artboardsForFinding(document, finding, scope);
  const nodeIds = [...new Set(finding.nodeIds ?? [])];
  if (
    finding.kind !== "objective" ||
    finding.category !== "production" ||
    !artboard ||
    nodeIds.length === 0 ||
    !nodeIds.every((nodeId) => {
      const node = document.nodes[nodeId];
      return (
        node !== undefined &&
        !node.locked &&
        artboard.nodeIds.includes(nodeId)
      );
    })
  ) {
    return null;
  }
  const bounds = nodeIds.flatMap((nodeId) => {
    const value = visualBounds(document, nodeId);
    return value ? [value] : [];
  });
  if (bounds.length !== nodeIds.length) {
    return null;
  }
  const left = Math.min(...bounds.map((item) => item.x));
  const top = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(
    ...bounds.map((item) => item.x + item.width),
  );
  const bottom = Math.max(
    ...bounds.map((item) => item.y + item.height),
  );
  const width = right - left;
  const height = bottom - top;
  if (
    ![left, top, right, bottom, width, height].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  const margin = Math.min(
    24,
    Math.max(4, Math.min(artboard.width, artboard.height) * 0.04),
  );
  const availableWidth = Math.max(1, artboard.width - margin * 2);
  const availableHeight = Math.max(1, artboard.height - margin * 2);
  const scale = Math.min(
    1,
    availableWidth / width,
    availableHeight / height,
  );
  if (
    scale < DESIGN_MATE_PROPOSAL_LIMITS.minimumScale ||
    scale > DESIGN_MATE_PROPOSAL_LIMITS.maximumScale
  ) {
    return null;
  }
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  const centerX = left + width / 2;
  const centerY = top + height / 2;
  const scaledLeft = centerX - scaledWidth / 2;
  const scaledTop = centerY - scaledHeight / 2;
  const scaledRight = scaledLeft + scaledWidth;
  const scaledBottom = scaledTop + scaledHeight;
  const dx =
    scaledLeft < margin
      ? margin - scaledLeft
      : scaledRight > artboard.width - margin
        ? artboard.width - margin - scaledRight
        : 0;
  const dy =
    scaledTop < margin
      ? margin - scaledTop
      : scaledBottom > artboard.height - margin
        ? artboard.height - margin - scaledBottom
        : 0;
  if (
    Math.abs(dx) > DESIGN_MATE_PROPOSAL_LIMITS.maximumTranslation ||
    Math.abs(dy) > DESIGN_MATE_PROPOSAL_LIMITS.maximumTranslation
  ) {
    return null;
  }
  const actions: DesignMateAction[] = [];
  if (scale < 0.9999) {
    const roundedScale = Number(scale.toFixed(4));
    actions.push({
      type: "scale-nodes",
      nodeIds,
      scaleX: roundedScale,
      scaleY: roundedScale,
    });
  }
  if (Math.abs(dx) >= 0.01 || Math.abs(dy) >= 0.01) {
    actions.push({
      type: "translate-nodes",
      nodeIds,
      dx: Number(dx.toFixed(2)),
      dy: Number(dy.toFixed(2)),
    });
  }
  if (actions.length === 0) {
    return null;
  }

  return makeMultiActionProposal(
    finding,
    "fit-artwork-to-artboard",
    `${artboard.id}:${nodeIds.join(",")}`,
    "Fit overflowing artwork inside export bounds",
    "Uniformly scales only when necessary, then moves the referenced top-level artwork inside a conservative artboard margin.",
    "medium",
    actions,
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

function buildContrastProposals(
  document: LogoDocument,
  finding: ReviewFinding,
  scope: ReviewScope,
): DesignMateProposal[] {
  if (
    finding.kind !== "objective" ||
    finding.category !== "color" ||
    finding.artboardId === undefined
  ) {
    return [];
  }
  const [artboard] = artboardsForFinding(document, finding, scope);
  if (!artboard) {
    return [];
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
    return [];
  }
  const target = candidates[0]!;
  if (
    target.opacity <= 0.5 ||
    !isValidDesignMateSolidColor(target.fill.color) ||
    !isValidDesignMateSolidColor(artboard.background)
  ) {
    return [];
  }
  const currentColor = normalizeDesignMateSolidColor(target.fill.color);
  const background = normalizeDesignMateSolidColor(artboard.background);
  if (
    logoColorContrastRatio(currentColor, background) >=
    LOGO_REVIEW_CONTRAST_THRESHOLD
  ) {
    return [];
  }

  return contrastCandidates(document)
    .filter(
      (color) =>
        color !== currentColor &&
        logoColorContrastRatio(color, background) >=
          LOGO_REVIEW_CONTRAST_THRESHOLD,
    )
    .slice(0, 2)
    .map((replacement, index) =>
      makeProposal(
        finding,
        "increase-color-contrast",
        `${target.id}:${replacement}`,
        index === 0
          ? "Increase color contrast"
          : "Try an alternate contrast color",
        `Uses a deterministic palette color or neutral that meets the ${LOGO_REVIEW_CONTRAST_THRESHOLD}:1 review threshold.`,
        "medium",
        {
          type: "set-fill-color",
          nodeId: target.id,
          color: replacement,
        },
      ),
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
  const addProposal = (proposal: DesignMateProposal | null): void => {
    if (!proposal) {
      return;
    }
    const mutationKey = JSON.stringify(proposal.actions);
    if (seenMutations.has(mutationKey)) {
      return;
    }
    seenMutations.add(mutationKey);
    proposals.push(proposal);
  };
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
      if (actionId === "increase-color-contrast") {
        for (const proposal of buildContrastProposals(
          document,
          finding,
          scope,
        )) {
          addProposal(proposal);
        }
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
      } else if (actionId === "fit-artwork-to-artboard") {
        proposal = buildFitArtworkProposal(document, finding, scope);
      } else {
        const purpose = variantPurposeForAction(actionId);
        proposal = purpose
          ? buildVariantProposal(document, finding, scope, purpose)
          : null;
      }
      addProposal(proposal);
    }
  }

  return proposals;
}
