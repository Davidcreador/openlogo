import {
  collectLeafNodeIds,
  getRenderNodesForArtboard,
  LOGO_REVIEW_CONTRAST_THRESHOLD,
  logoColorContrastRatio,
} from "@openlogo/core";
import type {
  Artboard,
  LogoDocument,
  LogoNode,
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
  | "increase-color-contrast"
  | "create-icon-variant"
  | "create-wordmark-variant";

type SolidLeafNode = Exclude<LogoNode, { type: "group" }> & {
  readonly fill: SolidPaint;
};

const SUPPORTED_FINDING_ACTIONS: readonly SupportedFindingAction[] = [
  "align-wordmark-with-brief",
  "increase-color-contrast",
  "create-icon-variant",
  "create-wordmark-variant",
];

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
  purpose: "icon" | "wordmark",
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

  const actionId =
    purpose === "icon" ? "create-icon-variant" : "create-wordmark-variant";
  return makeProposal(
    finding,
    actionId,
    `${source.id}:${purpose}`,
    purpose === "icon"
      ? "Create icon logo variant"
      : "Create wordmark logo variant",
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
 * Bind only objective findings with unambiguous, currently valid mutations.
 * Subjective, destructive, or geometry-heavy suggestions are deliberately
 * left for human judgment.
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

      const proposal =
        actionId === "align-wordmark-with-brief"
          ? buildBriefAlignmentProposal(document, finding, scope)
          : actionId === "increase-color-contrast"
            ? buildContrastProposal(document, finding, scope)
            : buildVariantProposal(
                document,
                finding,
                scope,
                actionId === "create-icon-variant" ? "icon" : "wordmark",
              );
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
