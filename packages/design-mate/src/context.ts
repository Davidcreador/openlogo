import {
  collectLeafNodeIds,
  getActiveArtboard,
  getRenderNodesForArtboard,
  selectionFrame,
  visualBounds,
} from "@openlogo/core";
import type {
  Artboard,
  DesignBrief,
  LogoDocument,
  LogoNode,
  Paint,
  ReviewScope,
  TextNode,
} from "@openlogo/core";
import type {
  BuildDesignContextOptions,
  DesignContext,
  DesignContextPaint,
  DesignContextSelectedNode,
  DesignContextSelectedNodeArtboard,
  DesignContextTypeStyle,
  DesignMateSelection,
} from "./contracts";

/**
 * Hard output limits for DesignContext. Counts always describe the complete
 * committed document; arrays and user-authored text are projected within
 * these limits and paired with explicit truncation flags. Reference ids are
 * always preserved verbatim.
 */
export const DESIGN_CONTEXT_LIMITS = {
  variants: 12,
  paletteColors: 48,
  typographyFamilies: 16,
  typographyStyles: 24,
  selectedNodes: 24,
  paintColorsPerNode: 8,
  nameLength: 160,
  textContentLength: 240,
  fontFamilyLength: 160,
  briefProseLength: 800,
  briefListItems: 12,
  briefListItemLength: 160,
} as const;

type TruncatedText = {
  readonly value: string;
  readonly truncated: boolean;
};

function truncateText(value: string, limit: number): TruncatedText {
  return {
    value: value.slice(0, limit),
    truncated: value.length > limit,
  };
}

function boundedBrief(
  brief: DesignBrief | undefined,
): { readonly value: DesignBrief | null; readonly truncated: boolean } {
  if (brief === undefined) {
    return { value: null, truncated: false };
  }

  let truncated = false;
  const prose = (value: string | undefined, limit: number): string | undefined => {
    if (value === undefined) {
      return undefined;
    }
    const bounded = truncateText(value, limit);
    truncated ||= bounded.truncated;
    return bounded.value;
  };
  const list = (value: string[] | undefined): string[] | undefined => {
    if (value === undefined) {
      return undefined;
    }
    truncated ||= value.length > DESIGN_CONTEXT_LIMITS.briefListItems;
    return value
      .slice(0, DESIGN_CONTEXT_LIMITS.briefListItems)
      .map((item) => {
        const bounded = truncateText(
          item,
          DESIGN_CONTEXT_LIMITS.briefListItemLength,
        );
        truncated ||= bounded.truncated;
        return bounded.value;
      });
  };

  const brandName = prose(brief.brandName, DESIGN_CONTEXT_LIMITS.nameLength);
  const offering = prose(
    brief.offering,
    DESIGN_CONTEXT_LIMITS.briefProseLength,
  );
  const audience = prose(
    brief.audience,
    DESIGN_CONTEXT_LIMITS.briefProseLength,
  );
  const attributes = list(brief.attributes);
  const avoid = list(brief.avoid);
  const competitors = list(brief.competitors);
  const primaryUseCases = list(brief.primaryUseCases);
  const mustKeep = list(brief.mustKeep);
  const constraints = prose(
    brief.constraints,
    DESIGN_CONTEXT_LIMITS.briefProseLength,
  );
  const notes = prose(brief.notes, DESIGN_CONTEXT_LIMITS.briefProseLength);

  return {
    value: {
      ...(brandName !== undefined ? { brandName } : {}),
      ...(offering !== undefined ? { offering } : {}),
      ...(audience !== undefined ? { audience } : {}),
      ...(attributes !== undefined ? { attributes } : {}),
      ...(avoid !== undefined ? { avoid } : {}),
      ...(competitors !== undefined ? { competitors } : {}),
      ...(primaryUseCases !== undefined ? { primaryUseCases } : {}),
      ...(mustKeep !== undefined ? { mustKeep } : {}),
      ...(constraints !== undefined ? { constraints } : {}),
      ...(notes !== undefined ? { notes } : {}),
    },
    truncated,
  };
}

function paintColors(paint: Paint): string[] {
  return paint.type === "solid"
    ? [paint.color]
    : paint.stops.map((stop) => stop.color);
}

function summarizePaint(paint: Paint): DesignContextPaint {
  const colors = paintColors(paint);
  return {
    type: paint.type,
    colors: colors.slice(0, DESIGN_CONTEXT_LIMITS.paintColorsPerNode),
    colorsTruncated:
      colors.length > DESIGN_CONTEXT_LIMITS.paintColorsPerNode,
  };
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type TypographyProjection = {
  readonly value: DesignContext["typography"];
  readonly familiesTruncated: boolean;
  readonly stylesTruncated: boolean;
};

function summarizeTypography(nodes: readonly LogoNode[]): TypographyProjection {
  const textNodes = nodes.filter((node): node is TextNode => node.type === "text");
  const familyCounts = new Map<string, number>();
  const styles = new Map<
    string,
    Omit<DesignContextTypeStyle, "fontFamily" | "textNodeCount"> & {
      readonly rawFontFamily: string;
      textNodeCount: number;
    }
  >();

  for (const node of textNodes) {
    familyCounts.set(
      node.fontFamily,
      (familyCounts.get(node.fontFamily) ?? 0) + 1,
    );
    const fontStyle = node.fontStyle ?? "normal";
    const styleKey = JSON.stringify([
      node.fontFamily,
      node.fontSize,
      node.fontWeight,
      fontStyle,
      node.letterSpacing,
      node.lineHeight,
    ]);
    const existing = styles.get(styleKey);
    if (existing) {
      existing.textNodeCount += 1;
    } else {
      styles.set(styleKey, {
        rawFontFamily: node.fontFamily,
        fontSize: node.fontSize,
        fontWeight: node.fontWeight,
        fontStyle,
        letterSpacing: node.letterSpacing,
        lineHeight: node.lineHeight,
        textNodeCount: 1,
      });
    }
  }

  const sortedFamilies = [...familyCounts.entries()].sort(([left], [right]) =>
    compareString(left, right),
  );
  let familiesTruncated =
    sortedFamilies.length > DESIGN_CONTEXT_LIMITS.typographyFamilies;
  const fontFamilies = sortedFamilies
    .slice(0, DESIGN_CONTEXT_LIMITS.typographyFamilies)
    .map(([family, textNodeCount]) => {
      const bounded = truncateText(
        family,
        DESIGN_CONTEXT_LIMITS.fontFamilyLength,
      );
      familiesTruncated ||= bounded.truncated;
      return { family: bounded.value, textNodeCount };
    });

  const sortedStyles = [...styles.values()].sort(
    (left, right) =>
      compareString(left.rawFontFamily, right.rawFontFamily) ||
      left.fontSize - right.fontSize ||
      left.fontWeight - right.fontWeight ||
      compareString(left.fontStyle, right.fontStyle) ||
      left.letterSpacing - right.letterSpacing ||
      left.lineHeight - right.lineHeight,
  );
  let stylesTruncated =
    sortedStyles.length > DESIGN_CONTEXT_LIMITS.typographyStyles;
  const boundedStyles = sortedStyles
    .slice(0, DESIGN_CONTEXT_LIMITS.typographyStyles)
    .map((style): DesignContextTypeStyle => {
      const bounded = truncateText(
        style.rawFontFamily,
        DESIGN_CONTEXT_LIMITS.fontFamilyLength,
      );
      stylesTruncated ||= bounded.truncated;
      return {
        fontFamily: bounded.value,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        letterSpacing: style.letterSpacing,
        lineHeight: style.lineHeight,
        textNodeCount: style.textNodeCount,
      };
    });

  return {
    value: {
      textNodeCount: textNodes.length,
      fontFamilies,
      styles: boundedStyles,
    },
    familiesTruncated,
    stylesTruncated,
  };
}

function mapNodeArtboards(document: LogoDocument): Map<string, Artboard> {
  const owners = new Map<string, Artboard>();

  const visit = (nodeId: string, artboard: Artboard): void => {
    if (owners.has(nodeId)) {
      return;
    }
    const node = document.nodes[nodeId];
    if (!node) {
      return;
    }
    owners.set(nodeId, artboard);
    if (node.type === "group") {
      node.children.forEach((childId) => visit(childId, artboard));
    }
  };

  for (const artboard of document.artboards) {
    artboard.nodeIds.forEach((nodeId) => visit(nodeId, artboard));
  }
  return owners;
}

function summarizeSelectedNodeArtboard(
  artboard: Artboard,
): DesignContextSelectedNodeArtboard {
  const name = truncateText(artboard.name, DESIGN_CONTEXT_LIMITS.nameLength);
  return {
    id: artboard.id,
    name: name.value,
    nameTruncated: name.truncated,
    purpose: artboard.purpose,
    x: artboard.x,
    y: artboard.y,
    width: artboard.width,
    height: artboard.height,
    background: artboard.background,
  };
}

function summarizeSelectedNode(
  document: LogoDocument,
  node: LogoNode,
  owningArtboard: Artboard | undefined,
): {
  readonly value: DesignContextSelectedNode;
  readonly textTruncated: boolean;
} {
  const name = truncateText(node.name, DESIGN_CONTEXT_LIMITS.nameLength);
  const bounds = visualBounds(document, node.id);
  const artboard = owningArtboard
    ? summarizeSelectedNodeArtboard(owningArtboard)
    : null;
  const worldBounds =
    bounds && owningArtboard
      ? {
          x: bounds.x + owningArtboard.x,
          y: bounds.y + owningArtboard.y,
          width: bounds.width,
          height: bounds.height,
        }
      : null;
  const common = {
    id: node.id,
    name: name.value,
    nameTruncated: name.truncated,
    bounds: bounds ? { ...bounds } : null,
    worldBounds,
    artboard,
    opacity: node.opacity,
    visible: node.visible,
    locked: node.locked,
  };
  const commonTextTruncated = name.truncated || artboard?.nameTruncated === true;

  if (node.type === "group") {
    return {
      value: {
        ...common,
        type: node.type,
        rotation: null,
        childCount: node.children.length,
        ...(node.clippingMaskId
          ? { clippingMaskId: node.clippingMaskId }
          : {}),
      },
      textTruncated: commonTextTruncated,
    };
  }

  const stroke = node.stroke
    ? {
        width: node.stroke.width,
        align: node.stroke.align,
        paint: summarizePaint(
          node.stroke.paint ?? { type: "solid", color: node.stroke.color },
        ),
      }
    : undefined;
  const visual = {
    ...common,
    type: node.type,
    rotation: node.rotation,
    fill: summarizePaint(node.fill),
    ...(stroke ? { stroke } : {}),
  };

  if (node.type === "text") {
    const content = truncateText(
      node.content,
      DESIGN_CONTEXT_LIMITS.textContentLength,
    );
    const fontFamily = truncateText(
      node.fontFamily,
      DESIGN_CONTEXT_LIMITS.fontFamilyLength,
    );
    return {
      value: {
        ...visual,
        text: {
          content: content.value,
          contentTruncated: content.truncated,
          fontFamily: fontFamily.value,
          fontSize: node.fontSize,
          fontWeight: node.fontWeight,
          fontStyle: node.fontStyle ?? "normal",
          letterSpacing: node.letterSpacing,
          lineHeight: node.lineHeight,
          align: node.align,
          onPath: node.onPath !== undefined,
        },
      },
      textTruncated:
        commonTextTruncated || content.truncated || fontFamily.truncated,
    };
  }

  if (node.type === "path") {
    return {
      value: {
        ...visual,
        path: {
          fillRule: node.fillRule,
          hasEditableGeometry: node.geometry !== undefined,
          subpathCount: node.geometry?.subpaths.length ?? 0,
        },
      },
      textTruncated: commonTextTruncated,
    };
  }
  if (node.type === "rectangle") {
    return {
      value: { ...visual, cornerRadius: node.cornerRadius },
      textTruncated: commonTextTruncated,
    };
  }
  return { value: visual, textTruncated: commonTextTruncated };
}

function uniqueExistingSelectionIds(
  document: LogoDocument,
  selectedNodeIds: readonly string[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of selectedNodeIds) {
    if (!seen.has(id) && document.nodes[id] !== undefined) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function resolveDesignMateScope(
  selection: DesignMateSelection,
  requestedScope?: ReviewScope,
): ReviewScope {
  return (
    requestedScope ??
    (selection.selectedNodeIds.length > 0 ? "selection" : "active-artboard")
  );
}

export function buildDesignContext(
  document: LogoDocument,
  selection: DesignMateSelection,
  options: BuildDesignContextOptions = {},
): DesignContext {
  const activeArtboard = getActiveArtboard(document);
  const activeNodes = getRenderNodesForArtboard(document, activeArtboard.id);
  const allNodes = Object.values(document.nodes);
  const validSelectionIds = uniqueExistingSelectionIds(
    document,
    selection.selectedNodeIds,
  );
  const validSelectionSet = new Set(validSelectionIds);
  const nodeArtboards = mapNodeArtboards(document);
  const selectedLeafIds = collectLeafNodeIds(
    document,
    validSelectionIds,
  ).filter((nodeId) => nodeArtboards.has(nodeId));
  const requestedScope = resolveDesignMateScope(selection, options.scope);
  // Keep the context/provider contract aligned with core review semantics:
  // an explicitly requested selection review cannot stay selection-scoped
  // when selected units are stale, unreachable, or resolve to no leaf nodes.
  const scope =
    requestedScope === "selection" && selectedLeafIds.length === 0
      ? "active-artboard"
      : requestedScope;

  const documentName = truncateText(
    document.name,
    DESIGN_CONTEXT_LIMITS.nameLength,
  );
  const artboardName = truncateText(
    activeArtboard.name,
    DESIGN_CONTEXT_LIMITS.nameLength,
  );
  const brief = boundedBrief(document.designBrief);

  let variantsTruncated =
    document.artboards.length > DESIGN_CONTEXT_LIMITS.variants;
  const variants = document.artboards
    .slice(0, DESIGN_CONTEXT_LIMITS.variants)
    .map((artboard) => {
      const name = truncateText(
        artboard.name,
        DESIGN_CONTEXT_LIMITS.nameLength,
      );
      variantsTruncated ||= name.truncated;
      return {
        id: artboard.id,
        name: name.value,
        purpose: artboard.purpose,
        width: artboard.width,
        height: artboard.height,
        background: artboard.background,
        topLevelNodeCount: artboard.nodeIds.length,
      };
    });

  const totalPaletteColors = document.palettes.reduce(
    (total, palette) => total + palette.colors.length,
    0,
  );
  const paletteColors: string[] = [];
  for (const palette of document.palettes) {
    for (const color of palette.colors) {
      if (paletteColors.length === DESIGN_CONTEXT_LIMITS.paletteColors) {
        break;
      }
      paletteColors.push(color);
    }
    if (paletteColors.length === DESIGN_CONTEXT_LIMITS.paletteColors) {
      break;
    }
  }

  const typography = summarizeTypography(allNodes);
  let selectedNodeTextTruncated = false;
  const selectedNodes = validSelectionIds
    .slice(0, DESIGN_CONTEXT_LIMITS.selectedNodes)
    .map((id) => {
      const summary = summarizeSelectedNode(
        document,
        document.nodes[id]!,
        nodeArtboards.get(id),
      );
      selectedNodeTextTruncated ||= summary.textTruncated;
      return summary.value;
    });

  const frame = selectionFrame(document, validSelectionIds);
  const groupNodeCount = allNodes.filter((node) => node.type === "group").length;
  const textNodeCount = allNodes.filter((node) => node.type === "text").length;
  const leafNodeCount = allNodes.length - groupNodeCount;
  const scopeLeafNodeCount =
    scope === "selection"
      ? selectedLeafIds.length
      : scope === "active-artboard"
        ? activeNodes.length
        : document.artboards.reduce(
            (total, artboard) =>
              total + getRenderNodesForArtboard(document, artboard.id).length,
            0,
          );
  const activeGroup = selection.activeGroupId
    ? document.nodes[selection.activeGroupId]
    : undefined;

  return {
    scope,
    document: {
      id: document.id,
      name: documentName.value,
      schemaVersion: document.schemaVersion,
    },
    designBrief: brief.value,
    activeArtboard: {
      id: activeArtboard.id,
      name: artboardName.value,
      purpose: activeArtboard.purpose,
      x: activeArtboard.x,
      y: activeArtboard.y,
      width: activeArtboard.width,
      height: activeArtboard.height,
      background: activeArtboard.background,
      topLevelNodeCount: activeArtboard.nodeIds.length,
      leafNodeCount: activeNodes.length,
    },
    variants,
    paletteColors,
    typography: typography.value,
    metrics: {
      artboardCount: document.artboards.length,
      nodeCount: allNodes.length,
      leafNodeCount,
      groupNodeCount,
      textNodeCount,
      visibleNodeCount: allNodes.filter((node) => node.visible).length,
      hiddenNodeCount: allNodes.filter((node) => !node.visible).length,
      lockedNodeCount: allNodes.filter((node) => node.locked).length,
      paletteCount: document.palettes.length,
      paletteColorCount: totalPaletteColors,
      activeArtboardLeafNodeCount: activeNodes.length,
      selectedNodeCount: validSelectionIds.length,
      scopeLeafNodeCount,
    },
    selection: {
      selectedNodeCount: validSelectionIds.length,
      ...(selection.keyObjectId &&
      validSelectionSet.has(selection.keyObjectId)
        ? { keyObjectId: selection.keyObjectId }
        : {}),
      ...(selection.activeGroupId && activeGroup?.type === "group"
        ? { activeGroupId: selection.activeGroupId }
        : {}),
    },
    selectedNodes,
    selectionFrame: frame
      ? {
          bounds: { ...frame.bounds },
          rotation: frame.rotation,
        }
      : null,
    truncation: {
      documentText: documentName.truncated,
      designBrief: brief.truncated,
      activeArtboard: artboardName.truncated,
      variants: variantsTruncated,
      paletteColors:
        totalPaletteColors > DESIGN_CONTEXT_LIMITS.paletteColors,
      typographyFamilies: typography.familiesTruncated,
      typographyStyles: typography.stylesTruncated,
      selectedNodes:
        validSelectionIds.length > DESIGN_CONTEXT_LIMITS.selectedNodes,
      selectedNodeText: selectedNodeTextTruncated,
    },
  };
}
