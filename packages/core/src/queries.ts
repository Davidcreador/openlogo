import { type Bounds, type Vec2, boundsUnion, rotatedBounds } from "./geometry";
import type { PathGeometry } from "./path-data";
import type { Artboard, GroupNode, LogoDocument, LogoNode, PathNode } from "./types";

export function getActiveArtboard(document: LogoDocument): Artboard {
  const active = document.artboards.find(
    (artboard) => artboard.id === document.activeArtboardId,
  );

  if (!active) {
    throw new Error("Active artboard is missing from the document.");
  }

  return active;
}

/** Canvas gap between adjacent artboards on the shared surface. */
export const ARTBOARD_GAP = 120;

/**
 * Canvas position for a new artboard of the given size: adjacent to the
 * right of the anchor artboard (normally the active one), pushed further
 * right past any artboard it would overlap so boards never stack.
 */
export function nextArtboardPosition(
  document: LogoDocument,
  anchorArtboardId: string,
  size: { width: number; height: number },
): { x: number; y: number } {
  const anchor =
    document.artboards.find((item) => item.id === anchorArtboardId) ??
    document.artboards[0];
  if (!anchor) {
    return { x: 0, y: 0 };
  }

  const y = anchor.y;
  let x = anchor.x + anchor.width + ARTBOARD_GAP;

  const blockerAt = (candidateX: number) =>
    document.artboards.find(
      (item) =>
        candidateX < item.x + item.width &&
        candidateX + size.width > item.x &&
        y < item.y + item.height &&
        y + size.height > item.y,
    );

  // Each pass clears one blocker by moving strictly right; N boards can
  // block at most N times.
  for (let i = 0; i <= document.artboards.length; i += 1) {
    const blocker = blockerAt(x);
    if (!blocker) {
      break;
    }
    x = blocker.x + blocker.width + ARTBOARD_GAP;
  }

  return { x, y };
}

/** Top-level nodes of an artboard (includes group nodes, not their children). */
export function getNodesForArtboard(
  document: LogoDocument,
  artboardId = document.activeArtboardId,
): LogoNode[] {
  const artboard = document.artboards.find((item) => item.id === artboardId);

  if (!artboard) {
    return [];
  }

  return artboard.nodeIds
    .map((id) => document.nodes[id])
    .filter((node): node is LogoNode => Boolean(node));
}

/*
 * Group-aware derived queries. Documents are immutable snapshots (every
 * command produces a new object), so per-document WeakMap caches are
 * both safe and self-cleaning.
 */

const parentMapCache = new WeakMap<LogoDocument, Map<string, string>>();

/** child id → containing group id, for every grouped node. */
export function getParentMap(document: LogoDocument): Map<string, string> {
  let map = parentMapCache.get(document);
  if (map) {
    return map;
  }
  map = new Map();
  for (const node of Object.values(document.nodes)) {
    if (node.type === "group") {
      for (const childId of node.children) {
        map.set(childId, node.id);
      }
    }
  }
  parentMapCache.set(document, map);
  return map;
}

export function getParentGroupId(
  document: LogoDocument,
  nodeId: string,
): string | null {
  return getParentMap(document).get(nodeId) ?? null;
}

/** Group that explicitly owns this node as its clipping path, if any. */
export function getClippingMaskOwnerId(
  document: LogoDocument,
  nodeId: string,
): string | null {
  const parentId = getParentGroupId(document, nodeId);
  const parent = parentId ? document.nodes[parentId] : undefined;
  return parent?.type === "group" && parent.clippingMaskId === nodeId
    ? parent.id
    : null;
}

export function isClippingMaskNode(
  document: LogoDocument,
  nodeId: string,
): boolean {
  return getClippingMaskOwnerId(document, nodeId) !== null;
}

/** Ancestor group ids of a node, outermost first. */
export function getAncestorGroupIds(
  document: LogoDocument,
  nodeId: string,
): string[] {
  const map = getParentMap(document);
  const chain: string[] = [];
  const seen = new Set<string>([nodeId]);
  let current = map.get(nodeId);
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.unshift(current);
    current = map.get(current);
  }
  return chain;
}

/**
 * Container of a node: its parent group id, or the id of the artboard
 * whose nodeIds list holds it. Null when the node is not in the scene.
 */
export function findContainerId(
  document: LogoDocument,
  nodeId: string,
): string | null {
  const parent = getParentGroupId(document, nodeId);
  if (parent) {
    return parent;
  }
  for (const artboard of document.artboards) {
    if (artboard.nodeIds.includes(nodeId)) {
      return artboard.id;
    }
  }
  return null;
}

/** Ordered child ids of a container (artboard id or group id). */
export function getContainerChildIds(
  document: LogoDocument,
  containerId: string,
): readonly string[] {
  const artboard = document.artboards.find((item) => item.id === containerId);
  if (artboard) {
    return artboard.nodeIds;
  }
  const node = document.nodes[containerId];
  return node?.type === "group" ? node.children : [];
}

/** A node id plus every descendant id (groups expanded recursively). */
export function collectSubtreeIds(
  document: LogoDocument,
  nodeId: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    const node = document.nodes[id];
    if (!node || seen.has(id)) {
      return;
    }
    seen.add(id);
    out.push(id);
    if (node.type === "group") {
      node.children.forEach(visit);
    }
  };
  visit(nodeId);
  return out;
}

/** Leaf (drawable) node ids under the given ids, groups expanded, deduped. */
export function collectLeafNodeIds(
  document: LogoDocument,
  nodeIds: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    const node = document.nodes[id];
    if (!node || seen.has(id)) {
      return;
    }
    seen.add(id);
    if (node.type === "group") {
      node.children.forEach(visit);
    } else {
      out.push(id);
    }
  };
  nodeIds.forEach(visit);
  return out;
}

/**
 * Deletion closure: the ids plus all descendants, plus any ancestor
 * groups left empty by the deletion (empty groups are pruned).
 */
export function expandDeletionSet(
  document: LogoDocument,
  nodeIds: readonly string[],
): string[] {
  const set = new Set<string>();
  for (const id of nodeIds) {
    for (const subId of collectSubtreeIds(document, id)) {
      set.add(subId);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of Object.values(document.nodes)) {
      if (
        node.type === "group" &&
        !set.has(node.id) &&
        node.children.length > 0 &&
        node.children.every((childId) => set.has(childId))
      ) {
        set.add(node.id);
        changed = true;
      }
    }
  }

  return [...set];
}

export function nodeBounds(node: LogoNode): Bounds {
  return rotatedBounds(
    { x: node.x, y: node.y, width: node.width, height: node.height },
    node.rotation,
  );
}

const visualBoundsCache = new WeakMap<
  LogoDocument,
  Map<string, Bounds | null>
>();
const paintBoundsCache = new WeakMap<
  LogoDocument,
  Map<string, Bounds | null>
>();

/**
 * Selection-unit bounds: a leaf's unrotated box (matching the editor's
 * drag/resize math), or a group's union of its children — derived,
 * never read from the group's placeholder fields.
 */
export function unitBounds(
  document: LogoDocument,
  nodeId: string,
): Bounds | null {
  const node = document.nodes[nodeId];
  if (!node) {
    return null;
  }
  return node.type === "group"
    ? visualBounds(document, nodeId)
    : { x: node.x, y: node.y, width: node.width, height: node.height };
}

/**
 * Axis-aligned geometry bounds after node rotations and clipping are applied.
 * Stroke/effect bleed is intentionally excluded; use `paintBounds` for export
 * and render extents.
 */
export function visualBounds(
  document: LogoDocument,
  nodeId: string,
): Bounds | null {
  return visualBoundsGuarded(document, nodeId, new Set());
}

function visualBoundsGuarded(
  document: LogoDocument,
  nodeId: string,
  visiting: Set<string>,
): Bounds | null {
  const node = document.nodes[nodeId];
  if (!node || visiting.has(nodeId)) {
    return null;
  }
  if (node.type !== "group") {
    return nodeBounds(node);
  }

  let cache = visualBoundsCache.get(document);
  if (!cache) {
    cache = new Map();
    visualBoundsCache.set(document, cache);
  }
  const cached = cache.get(nodeId);
  if (cached !== undefined) {
    return cached;
  }

  visiting.add(nodeId);
  const contentBounds = boundsUnion(
    node.children
      .filter((childId) => childId !== node.clippingMaskId)
      .map((childId) => visualBoundsGuarded(document, childId, visiting))
      .filter((item): item is Bounds => item !== null),
  );
  const maskBounds = node.clippingMaskId
    ? visualBoundsGuarded(document, node.clippingMaskId, visiting)
    : null;
  const bounds =
    node.clippingMaskId && maskBounds && contentBounds
      ? intersectBounds(maskBounds, contentBounds)
      : node.clippingMaskId
        ? null
        : contentBounds;
  visiting.delete(nodeId);
  cache.set(nodeId, bounds);
  return bounds;
}

/**
 * Conservative AABB of every pixel a subtree can paint. This extends visual
 * geometry for centered strokes and enabled effects while preserving renderer
 * order: child paint is clipped first, then group effects may bleed outside.
 */
export function paintBounds(
  document: LogoDocument,
  nodeId: string,
): Bounds | null {
  return paintBoundsGuarded(document, nodeId, new Set());
}

function paintBoundsGuarded(
  document: LogoDocument,
  nodeId: string,
  visiting: Set<string>,
): Bounds | null {
  const node = document.nodes[nodeId];
  if (!node || visiting.has(nodeId)) {
    return null;
  }

  let cache = paintBoundsCache.get(document);
  if (!cache) {
    cache = new Map();
    paintBoundsCache.set(document, cache);
  }
  const cached = cache.get(nodeId);
  if (cached !== undefined) {
    return cached;
  }

  let bounds: Bounds | null;
  if (node.type !== "group") {
    bounds = applyEffectBounds(
      expandBounds(nodeBounds(node), strokeOutset(node)),
      node.effects,
    );
  } else {
    visiting.add(nodeId);
    const contentBounds = boundsUnion(
      node.children
        .filter((childId) => childId !== node.clippingMaskId)
        .map((childId) => paintBoundsGuarded(document, childId, visiting))
        .filter((item): item is Bounds => item !== null),
    );
    const maskBounds = node.clippingMaskId
      ? visualBounds(document, node.clippingMaskId)
      : null;
    const clippedBounds =
      node.clippingMaskId && maskBounds && contentBounds
        ? intersectBounds(maskBounds, contentBounds)
        : node.clippingMaskId
          ? null
          : contentBounds;
    visiting.delete(nodeId);
    bounds = clippedBounds
      ? applyEffectBounds(clippedBounds, node.effects)
      : null;
  }

  cache.set(nodeId, bounds);
  return bounds;
}

function strokeOutset(node: LogoNode): number {
  if (!node.stroke || node.stroke.width <= 0) {
    return 0;
  }
  if (node.type !== "path") {
    return node.stroke.width / 2;
  }

  const scaleX = Math.abs(node.width / node.intrinsicWidth);
  const scaleY = Math.abs(node.height / node.intrinsicHeight);
  const scale = Math.max(scaleX, scaleY);
  return (node.stroke.width * (Number.isFinite(scale) ? scale : 1)) / 2;
}

function expandBounds(bounds: Bounds, amount: number): Bounds {
  const outset = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  return {
    x: bounds.x - outset,
    y: bounds.y - outset,
    width: bounds.width + outset * 2,
    height: bounds.height + outset * 2,
  };
}

function applyEffectBounds(
  source: Bounds,
  effects: LogoNode["effects"],
): Bounds {
  const parts = [source];
  for (const effect of effects ?? []) {
    if (!effect.enabled) {
      continue;
    }
    if (effect.type === "outline" && effect.width > 0) {
      parts.push(expandBounds(source, effect.width));
      continue;
    }
    if (effect.type === "glow" || effect.type === "drop-shadow") {
      // CanvasKit and SVG use sigma = blur / 2. Three sigma is a safe visual
      // cutoff that avoids clipping while keeping exports reasonably tight.
      const blurred = expandBounds(source, Math.max(0, effect.blur) * 1.5);
      const dx = effect.type === "drop-shadow" ? effect.dx : 0;
      const dy = effect.type === "drop-shadow" ? effect.dy : 0;
      parts.push({ ...blurred, x: blurred.x + dx, y: blurred.y + dy });
    }
    // Bevel passes are composited SrcATop and cannot paint outside source.
  }
  return boundsUnion(parts)!;
}

function intersectBounds(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null;
}

export function getSelectionBounds(
  document: LogoDocument,
  selectedNodeIds: readonly string[],
): Bounds | null {
  return boundsUnion(
    selectedNodeIds
      .map((id) => visualBounds(document, id))
      .filter((item): item is Bounds => item !== null),
  );
}

const renderListCache = new WeakMap<LogoDocument, Map<string, LogoNode[]>>();

/**
 * Drawable leaves of an artboard in paint order (DFS through groups).
 * Group visibility hides its subtree; group opacity and lock cascade
 * into the returned leaves (cloned only when they differ).
 */
export function getRenderNodesForArtboard(
  document: LogoDocument,
  artboardId = document.activeArtboardId,
): LogoNode[] {
  let perArtboard = renderListCache.get(document);
  if (!perArtboard) {
    perArtboard = new Map();
    renderListCache.set(document, perArtboard);
  }
  const cached = perArtboard.get(artboardId);
  if (cached) {
    return cached;
  }

  const artboard = document.artboards.find((item) => item.id === artboardId);
  const out: LogoNode[] = [];
  const seen = new Set<string>();

  const visit = (id: string, opacity: number, locked: boolean) => {
    const node = document.nodes[id];
    if (!node || seen.has(id)) {
      return;
    }
    seen.add(id);
    if (node.type === "group") {
      if (!node.visible) {
        return;
      }
      for (const childId of node.children) {
        if (childId === node.clippingMaskId) {
          continue;
        }
        visit(childId, opacity * node.opacity, locked || node.locked);
      }
      return;
    }
    if (opacity === 1 && locked === node.locked) {
      out.push(node);
    } else {
      out.push({
        ...node,
        opacity: node.opacity * opacity,
        locked: node.locked || locked,
      } as LogoNode);
    }
  };

  for (const id of artboard?.nodeIds ?? []) {
    visit(id, 1, false);
  }

  perArtboard.set(artboardId, out);
  return out;
}

export function isGroupNode(node: LogoNode | undefined): node is GroupNode {
  return node?.type === "group";
}

/**
 * Selection frame the editor draws handles on. A single rotated leaf
 * gets its own rotated box (the frame tilts with the node,
 * Illustrator-style); everything else gets the axis-aligned union of
 * unit bounds, with rotated leaves contributing their rotated AABBs so
 * the frame always contains what is on screen.
 */
export type SelectionFrame = {
  bounds: Bounds;
  /** Degrees; non-zero only for a single rotated leaf selection. */
  rotation: number;
};

export function selectionFrame(
  document: LogoDocument,
  selectedNodeIds: readonly string[],
): SelectionFrame | null {
  if (selectedNodeIds.length === 1) {
    const node = document.nodes[selectedNodeIds[0]!];
    if (node && node.type !== "group" && node.rotation !== 0) {
      return {
        bounds: {
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
        },
        rotation: node.rotation,
      };
    }
  }

  const parts: Bounds[] = [];
  for (const nodeId of selectedNodeIds) {
    const node = document.nodes[nodeId];
    if (!node) {
      continue;
    }
    const bounds =
      node.type === "group" ? unitBounds(document, nodeId) : nodeBounds(node);
    if (bounds) {
      parts.push(bounds);
    }
  }
  const union = boundsUnion(parts);
  return union ? { bounds: union, rotation: 0 } : null;
}

/** Centre of a selection frame (also its rotation pivot). */
export function selectionFrameCenter(frame: SelectionFrame): Vec2 {
  return {
    x: frame.bounds.x + frame.bounds.width / 2,
    y: frame.bounds.y + frame.bounds.height / 2,
  };
}

/**
 * A path node's structured geometry denormalised into artboard-local
 * coordinates (intrinsic space × box scale + position). Rotation is NOT
 * applied — callers that allow rotated nodes must handle it themselves.
 */
export function pathNodeLocalGeometry(node: PathNode): PathGeometry | null {
  if (!node.geometry) {
    return null;
  }
  const sx = node.width / node.intrinsicWidth;
  const sy = node.height / node.intrinsicHeight;
  const map = (p: Vec2): Vec2 => ({
    x: node.x + p.x * sx,
    y: node.y + p.y * sy,
  });

  return {
    subpaths: node.geometry.subpaths.map((subpath) => ({
      closed: subpath.closed,
      points: subpath.points.map((point) => ({
        ...map(point),
        ...(point.handleIn ? { handleIn: map(point.handleIn) } : {}),
        ...(point.handleOut ? { handleOut: map(point.handleOut) } : {}),
      })),
    })),
  };
}
