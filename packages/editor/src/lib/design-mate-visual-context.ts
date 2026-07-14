import {
  getActiveArtboard,
  getParentGroupId,
  paintBounds,
  type Artboard,
  type LogoDocument,
  type ReviewScope,
} from "@openlogo/core";
import {
  DESIGN_MATE_CHAT_LIMITS,
  buildDocumentIdentity,
  readDesignMatePngDimensions,
  type DesignMateSelection,
  type DesignMateVisualAttachment,
  type DesignMateVisualAttachmentKind,
  type DocumentIdentity,
} from "@openlogo/design-mate";
import { Effect } from "effect";
import { documentToSvg, svgToPngBytes } from "./export";
import { resolveEffectiveDesignMateScope } from "./design-mate-review";
import { embedDocumentFonts } from "./svg-fonts";

const DESIGN_MATE_VISUAL_MAX_EDGES = [512, 384, 256] as const;

type VisualBounds = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type DesignMateVisualTarget = {
  readonly key: string;
  readonly kind: DesignMateVisualAttachmentKind;
  readonly label: string;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly artboardId?: string;
  readonly nodeIds?: readonly string[];
  readonly selectionBounds?: VisualBounds;
};

export type DesignMateVisualPlan = {
  readonly scope: ReviewScope;
  readonly targets: readonly DesignMateVisualTarget[];
};

export type DesignMateRasterDimensions = {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
};

export type DesignMateVisualCaptureOptions = {
  readonly scope: ReviewScope;
  readonly generation: number;
  readonly revision: number;
  readonly signal?: AbortSignal;
};

export type DesignMateVisualCaptureDependencies = {
  readonly renderArtboard: (
    document: LogoDocument,
    artboard: Artboard,
  ) => string;
  readonly embedFonts: (
    svg: string,
    document: LogoDocument,
  ) => Promise<string>;
  readonly rasterizePng: (
    svg: string,
    width: number,
    height: number,
    scale: number,
  ) => Promise<Uint8Array>;
};

export type DesignMateVisualCaptureResult = {
  readonly scope: ReviewScope;
  readonly attachments: readonly DesignMateVisualAttachment[];
  readonly attemptedTargets: number;
  readonly failedTargets: number;
};

const DEFAULT_CAPTURE_DEPENDENCIES: DesignMateVisualCaptureDependencies = {
  renderArtboard: (document, artboard) => documentToSvg(document, artboard),
  embedFonts: (svg, document) =>
    Effect.runPromise(embedDocumentFonts(svg, document)),
  rasterizePng: (svg, width, height, scale) =>
    Effect.runPromise(svgToPngBytes(svg, width, height, scale)),
};

function boundedLabel(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const label = normalized.length > 0 ? normalized : fallback;
  return label.slice(0, DESIGN_MATE_CHAT_LIMITS.attachmentLabelLength);
}

function artboardTarget(
  artboard: Artboard,
  kind: DesignMateVisualAttachmentKind,
  prefix: string,
): DesignMateVisualTarget {
  return {
    key: `artboard:${artboard.id}`,
    kind,
    label: boundedLabel(
      `${prefix} · ${artboard.name} (${artboard.purpose})`,
      prefix,
    ),
    sourceWidth: artboard.width,
    sourceHeight: artboard.height,
    artboardId: artboard.id,
  };
}

function orderedSceneNodeIds(
  document: LogoDocument,
  artboard: Artboard,
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (nodeId: string) => {
    if (seen.has(nodeId) || !document.nodes[nodeId]) {
      return;
    }
    seen.add(nodeId);
    ordered.push(nodeId);
    const node = document.nodes[nodeId]!;
    if (node.type === "group") {
      node.children.forEach(visit);
    }
  };
  artboard.nodeIds.forEach(visit);
  return ordered;
}

function topLevelContextRoot(
  document: LogoDocument,
  nodeId: string,
): string | null {
  if (!document.nodes[nodeId]) {
    return null;
  }
  const seen = new Set([nodeId]);
  let root = nodeId;
  let parent = getParentGroupId(document, root);
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    root = parent;
    parent = getParentGroupId(document, root);
  }
  return root;
}

function artboardBounds(artboard: Artboard): VisualBounds {
  return { x: 0, y: 0, width: artboard.width, height: artboard.height };
}

function isFiniteVisualBounds(bounds: VisualBounds): boolean {
  return (
    [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function unionVisualBounds(bounds: readonly VisualBounds[]): VisualBounds | null {
  if (bounds.length === 0 || !bounds.every(isFiniteVisualBounds)) {
    return null;
  }
  const x = Math.min(...bounds.map((item) => item.x));
  const y = Math.min(...bounds.map((item) => item.y));
  const right = Math.max(...bounds.map((item) => item.x + item.width));
  const bottom = Math.max(...bounds.map((item) => item.y + item.height));
  return { x, y, width: right - x, height: bottom - y };
}

function intersectVisualBounds(
  left: VisualBounds,
  right: VisualBounds,
): VisualBounds | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  return rightEdge > x && bottomEdge > y
    ? { x, y, width: rightEdge - x, height: bottomEdge - y }
    : null;
}

/**
 * A selected descendant must retain every ancestor operation. Using the
 * top-level context root includes ancestor clipping, opacity and effects; the
 * full artboard render later retains backdrop/z-order inside this crop.
 */
function selectionContextBounds(
  document: LogoDocument,
  artboard: Artboard,
  nodeIds: readonly string[],
): VisualBounds {
  const roots = [
    ...new Set(
      nodeIds
        .map((nodeId) => topLevelContextRoot(document, nodeId))
        .filter((nodeId): nodeId is string => nodeId !== null),
    ),
  ];
  if (
    roots.length === 0 ||
    roots.some((rootId) => !artboard.nodeIds.includes(rootId))
  ) {
    return artboardBounds(artboard);
  }
  const rootBounds = roots.map((rootId) => paintBounds(document, rootId));
  if (rootBounds.some((bounds) => bounds === null)) {
    return artboardBounds(artboard);
  }
  const context = unionVisualBounds(
    rootBounds.filter((bounds): bounds is VisualBounds => bounds !== null),
  );
  if (!context) {
    return artboardBounds(artboard);
  }
  return (
    intersectVisualBounds(context, artboardBounds(artboard)) ??
    artboardBounds(artboard)
  );
}

function selectionLabel(
  document: LogoDocument,
  nodeIds: readonly string[],
): string {
  const names = nodeIds
    .slice(0, 2)
    .map((nodeId) => document.nodes[nodeId]?.name.trim())
    .filter((name): name is string => Boolean(name));
  const detail =
    names.length > 0
      ? names.join(", ")
      : `${nodeIds.length} selected ${nodeIds.length === 1 ? "object" : "objects"}`;
  return boundedLabel(`Selection · ${detail}`, "Selection");
}

function documentArtboards(
  document: LogoDocument,
  active: Artboard,
): readonly Artboard[] {
  const selected: Artboard[] = [active];
  const ids = new Set([active.id]);
  const purposes = new Set([active.purpose]);
  const others = document.artboards.filter((artboard) => !ids.has(artboard.id));

  for (const artboard of others) {
    if (selected.length >= DESIGN_MATE_CHAT_LIMITS.attachments) {
      break;
    }
    if (!purposes.has(artboard.purpose) && !ids.has(artboard.id)) {
      selected.push(artboard);
      ids.add(artboard.id);
      purposes.add(artboard.purpose);
    }
  }
  for (const artboard of others) {
    if (selected.length >= DESIGN_MATE_CHAT_LIMITS.attachments) {
      break;
    }
    if (!ids.has(artboard.id)) {
      selected.push(artboard);
      ids.add(artboard.id);
    }
  }
  return selected;
}

/**
 * Pure target planning. Document order is retained, while distinct variants
 * are preferred for the two document-overview slots.
 */
export function planDesignMateVisualTargets(
  document: LogoDocument,
  selection: DesignMateSelection,
  requestedScope: ReviewScope,
): DesignMateVisualPlan {
  const scope = resolveEffectiveDesignMateScope(
    requestedScope,
    document,
    selection.selectedNodeIds,
  );
  const active = getActiveArtboard(document);
  if (scope === "selection") {
    const selected = new Set(
      selection.selectedNodeIds.filter(
        (nodeId) => document.nodes[nodeId] !== undefined,
      ),
    );
    const selectedArtboards = document.artboards
      .map((artboard) => ({
        artboard,
        nodeIds: orderedSceneNodeIds(document, artboard).filter((nodeId) =>
          selected.has(nodeId),
        ),
      }))
      .filter(({ nodeIds }) => nodeIds.length > 0)
      .slice(0, DESIGN_MATE_CHAT_LIMITS.attachments);
    if (selectedArtboards.length === 0) {
      return { scope, targets: [] };
    }
    return {
      scope,
      targets: selectedArtboards.map(({ artboard, nodeIds }) => {
        const bounds = selectionContextBounds(document, artboard, nodeIds);
        return {
          key: `selection:${artboard.id}`,
          kind: "selection",
          label: boundedLabel(
            `${selectionLabel(document, nodeIds)} · ${artboard.name}`,
            "Selection",
          ),
          sourceWidth: bounds.width,
          sourceHeight: bounds.height,
          artboardId: artboard.id,
          nodeIds,
          selectionBounds: bounds,
        };
      }),
    };
  }
  if (scope === "active-artboard") {
    return {
      scope,
      targets: [artboardTarget(active, "active-artboard", "Active artboard")],
    };
  }
  return {
    scope,
    targets: documentArtboards(document, active).map((artboard, index) =>
      artboardTarget(
        artboard,
        index === 0 ? "active-artboard" : "document-overview",
        index === 0 ? "Active artboard" : "Document variant",
      ),
    ),
  };
}

export function calculateDesignMateRasterDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maximumEdge: number,
): DesignMateRasterDimensions | null {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    !Number.isSafeInteger(maximumEdge) ||
    maximumEdge < DESIGN_MATE_CHAT_LIMITS.attachmentMinimumDimension ||
    maximumEdge > DESIGN_MATE_CHAT_LIMITS.attachmentMaximumDimension
  ) {
    return null;
  }
  const scale = maximumEdge / Math.max(sourceWidth, sourceHeight);
  const width = Math.max(
    DESIGN_MATE_CHAT_LIMITS.attachmentMinimumDimension,
    sourceWidth >= sourceHeight
      ? maximumEdge
      : Math.ceil(sourceWidth * scale),
  );
  const height = Math.max(
    DESIGN_MATE_CHAT_LIMITS.attachmentMinimumDimension,
    sourceHeight >= sourceWidth
      ? maximumEdge
      : Math.ceil(sourceHeight * scale),
  );
  if (
    width > DESIGN_MATE_CHAT_LIMITS.attachmentMaximumDimension ||
    height > DESIGN_MATE_CHAT_LIMITS.attachmentMaximumDimension ||
    width * height > DESIGN_MATE_CHAT_LIMITS.attachmentPixels
  ) {
    return null;
  }
  return { width, height, scale };
}

/**
 * Keep the exact full-artboard SVG nested inside a bounded outer viewport.
 * Cropping therefore cannot reorder nodes or strip ancestor styles, while
 * transparent padding can satisfy the attachment's minimum pixel dimension.
 */
export function frameDesignMateArtboardSvg(
  svg: string,
  viewBox: VisualBounds,
): string | null {
  if (!isFiniteVisualBounds(viewBox)) {
    return null;
  }
  if (!/<svg\b[^>]*>/i.test(svg)) {
    return null;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${viewBox.width}" height="${viewBox.height}" viewBox="${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}" preserveAspectRatio="xMidYMid meet" role="img">
  ${svg}
</svg>`;
}

export function hasPngSignature(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10] as const;
  return signature.every((byte, index) => bytes[index] === byte);
}

export function isAcceptableDesignMatePng(
  bytes: Uint8Array,
  expectedWidth?: number,
  expectedHeight?: number,
): boolean {
  const dimensions = readDesignMatePngDimensions(bytes);
  return (
    bytes.byteLength <= DESIGN_MATE_CHAT_LIMITS.attachmentBytes &&
    dimensions !== null &&
    (expectedWidth === undefined || dimensions.width === expectedWidth) &&
    (expectedHeight === undefined || dimensions.height === expectedHeight)
  );
}

export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += alphabet[first >>> 2]!;
    encoded += alphabet[((first & 0x03) << 4) | ((second ?? 0) >>> 4)]!;
    encoded +=
      second === undefined
        ? "="
        : alphabet[((second & 0x0f) << 2) | ((third ?? 0) >>> 6)]!;
    encoded += third === undefined ? "=" : alphabet[third & 0x3f]!;
  }
  return encoded;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("Visual capture was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}

type RenderedVisualTarget = {
  readonly svg: string;
  readonly viewBox: VisualBounds;
};

function renderVisualTarget(
  target: DesignMateVisualTarget,
  document: LogoDocument,
  dependencies: DesignMateVisualCaptureDependencies,
): RenderedVisualTarget | null {
  const artboard = document.artboards.find(
    (item) => item.id === target.artboardId,
  );
  if (!artboard) {
    return null;
  }
  const viewBox =
    target.kind === "selection"
      ? target.selectionBounds
      : artboardBounds(artboard);
  if (!viewBox || !isFiniteVisualBounds(viewBox)) {
    return null;
  }
  return {
    svg: dependencies.renderArtboard(document, artboard),
    viewBox,
  };
}

async function captureTarget(
  target: DesignMateVisualTarget,
  index: number,
  document: LogoDocument,
  identity: DocumentIdentity,
  options: DesignMateVisualCaptureOptions,
  dependencies: DesignMateVisualCaptureDependencies,
): Promise<DesignMateVisualAttachment | null> {
  throwIfAborted(options.signal);
  const rendered = renderVisualTarget(target, document, dependencies);
  if (!rendered) {
    return null;
  }
  const artboardSvg = await dependencies.embedFonts(rendered.svg, document);
  throwIfAborted(options.signal);

  for (const maximumEdge of DESIGN_MATE_VISUAL_MAX_EDGES) {
    const dimensions = calculateDesignMateRasterDimensions(
      rendered.viewBox.width,
      rendered.viewBox.height,
      maximumEdge,
    );
    if (!dimensions) {
      continue;
    }
    // Integer PNG dimensions can require a small amount of transparent
    // padding. Expand the outer viewBox symmetrically and keep the content
    // scale uniform; this is a contain-fit, never a stretch.
    const rasterSourceWidth = dimensions.width / dimensions.scale;
    const rasterSourceHeight = dimensions.height / dimensions.scale;
    const viewBox = {
      x:
        rendered.viewBox.x -
        (rasterSourceWidth - rendered.viewBox.width) / 2,
      y:
        rendered.viewBox.y -
        (rasterSourceHeight - rendered.viewBox.height) / 2,
      width: rasterSourceWidth,
      height: rasterSourceHeight,
    };
    const svg = frameDesignMateArtboardSvg(artboardSvg, viewBox);
    if (!svg) {
      return null;
    }
    const bytes = await dependencies.rasterizePng(
      svg,
      rasterSourceWidth,
      rasterSourceHeight,
      dimensions.scale,
    );
    throwIfAborted(options.signal);
    if (bytes.byteLength > DESIGN_MATE_CHAT_LIMITS.attachmentBytes) {
      continue;
    }
    if (
      !isAcceptableDesignMatePng(
        bytes,
        dimensions.width,
        dimensions.height,
      )
    ) {
      return null;
    }
    return {
      id: `visual-${options.generation}-${options.revision}-${index + 1}`,
      kind: target.kind,
      mimeType: "image/png",
      dataBase64: bytesToBase64(bytes),
      width: dimensions.width,
      height: dimensions.height,
      byteLength: bytes.byteLength,
      identity,
      label: target.label,
    };
  }
  return null;
}

/**
 * Capture targets independently so one malformed or oversized variant never
 * prevents the remaining bounded visual context from being sent.
 */
export async function captureDesignMateVisualContext(
  document: LogoDocument,
  selection: DesignMateSelection,
  options: DesignMateVisualCaptureOptions,
  dependencies: DesignMateVisualCaptureDependencies = DEFAULT_CAPTURE_DEPENDENCIES,
): Promise<DesignMateVisualCaptureResult> {
  const plan = planDesignMateVisualTargets(
    document,
    selection,
    options.scope,
  );
  const attachments: DesignMateVisualAttachment[] = [];
  const identity = buildDocumentIdentity(document, {
    generation: options.generation,
    revision: options.revision,
  });
  let failedTargets = 0;
  for (let index = 0; index < plan.targets.length; index += 1) {
    throwIfAborted(options.signal);
    try {
      const attachment = await captureTarget(
        plan.targets[index]!,
        index,
        document,
        identity,
        options,
        dependencies,
      );
      if (attachment) {
        attachments.push(attachment);
      } else {
        failedTargets += 1;
      }
    } catch (cause) {
      if (options.signal?.aborted) {
        throw cause;
      }
      failedTargets += 1;
    }
  }
  return {
    scope: plan.scope,
    attachments,
    attemptedTargets: plan.targets.length,
    failedTargets,
  };
}