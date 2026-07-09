import { type Bounds, boundsUnion, rotatedBounds } from "./geometry";
import type { Artboard, GroupNode, LogoDocument, LogoNode } from "./types";

export function getActiveArtboard(document: LogoDocument): Artboard {
  const active = document.artboards.find(
    (artboard) => artboard.id === document.activeArtboardId,
  );

  if (!active) {
    throw new Error("Active artboard is missing from the document.");
  }

  return active;
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

const unitBoundsCache = new WeakMap<LogoDocument, Map<string, Bounds | null>>();

/**
 * Selection-unit bounds: a leaf's unrotated box (matching the editor's
 * drag/resize math), or a group's union of its children — derived,
 * never read from the group's placeholder fields.
 */
export function unitBounds(
  document: LogoDocument,
  nodeId: string,
): Bounds | null {
  return unitBoundsGuarded(document, nodeId, new Set());
}

function unitBoundsGuarded(
  document: LogoDocument,
  nodeId: string,
  visiting: Set<string>,
): Bounds | null {
  const node = document.nodes[nodeId];
  if (!node || visiting.has(nodeId)) {
    return null;
  }
  if (node.type !== "group") {
    return { x: node.x, y: node.y, width: node.width, height: node.height };
  }

  let cache = unitBoundsCache.get(document);
  if (!cache) {
    cache = new Map();
    unitBoundsCache.set(document, cache);
  }
  const cached = cache.get(nodeId);
  if (cached !== undefined) {
    return cached;
  }

  visiting.add(nodeId);
  const bounds = boundsUnion(
    node.children
      .map((childId) => unitBoundsGuarded(document, childId, visiting))
      .filter((item): item is Bounds => item !== null),
  );
  visiting.delete(nodeId);
  cache.set(nodeId, bounds);
  return bounds;
}

export function getSelectionBounds(
  document: LogoDocument,
  selectedNodeIds: readonly string[],
): Bounds | null {
  return boundsUnion(
    selectedNodeIds
      .map((id) => unitBounds(document, id))
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
