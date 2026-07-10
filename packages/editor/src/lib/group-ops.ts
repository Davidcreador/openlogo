import {
  type Bounds,
  type GroupNode,
  type LogoDocument,
  type LogoNode,
  type NodePatch,
  collectLeafNodeIds,
  collectSubtreeIds,
  createGroup,
  createId,
  expandDeletionSet,
  findContainerId,
  getAncestorGroupIds,
  getClippingMaskOwnerId,
  getContainerChildIds,
  getParentGroupId,
  rotatePoint,
  unitBounds,
} from "@openlogo/core";
import { documentStore } from "../state/document";

/**
 * Resolve a hit-tested leaf to the selection unit for the current group
 * scope. Outside any scope that is the outermost ancestor group; inside
 * a scope it is the scope's direct child on the leaf's ancestor path.
 * Clicking outside the scoped subtree pops scopes until one (or none)
 * contains the leaf. `deep` (⌘-click) always selects the leaf itself.
 */
export function resolveUnit(
  document: LogoDocument,
  leafId: string,
  activeGroupId: string | null,
  deep: boolean,
): { unitId: string; scopeId: string | null } {
  if (deep) {
    return { unitId: leafId, scopeId: activeGroupId };
  }

  const path = [...getAncestorGroupIds(document, leafId), leafId];

  let scope = activeGroupId;
  while (scope && !path.includes(scope)) {
    scope = getParentGroupId(document, scope);
  }

  const scopeIndex = scope ? path.indexOf(scope) : -1;
  return { unitId: path[scopeIndex + 1]!, scopeId: scope };
}

/** Leaf ids under the selected units (locked leaves included; callers filter). */
export function selectionLeafIds(
  selectedNodeIds: readonly string[],
): string[] {
  return collectLeafNodeIds(documentStore.document, selectedNodeIds);
}

/**
 * ⌘G: wrap the selected units in a new group. Units must share one
 * container (guaranteed by scope-based selection; mixed deep-selections
 * are a no-op). Returns the new group id.
 */
export function groupSelection(
  selectedNodeIds: readonly string[],
): string | null {
  const document = documentStore.document;
  const ids = selectedNodeIds.filter((id) => document.nodes[id]);
  if (
    ids.length < 2 ||
    ids.some((id) => getClippingMaskOwnerId(document, id) !== null)
  ) {
    return null;
  }

  const containers = new Set(ids.map((id) => findContainerId(document, id)));
  const containerId = [...containers][0];
  if (containers.size !== 1 || !containerId) {
    return null;
  }

  const list = getContainerChildIds(document, containerId);
  const ordered = list.filter((id) => ids.includes(id));
  if (ordered.length !== ids.length) {
    return null;
  }

  const indices = ordered.map((id) => list.indexOf(id));
  const insertAt = Math.max(...indices) - (ordered.length - 1);
  const group = createGroup(
    ordered,
    boundsOfUnits(document, ordered),
  );

  documentStore.apply({
    type: "group-nodes",
    containerId,
    group,
    index: insertAt,
  });

  return group.id;
}

/** ⇧⌘G: dissolve every selected group one level. Returns freed child ids. */
export function ungroupSelection(
  selectedNodeIds: readonly string[],
): string[] {
  const document = documentStore.document;
  const groups = selectedNodeIds
    .map((id) => document.nodes[id])
    .filter((node): node is GroupNode => node?.type === "group");
  if (groups.length === 0) {
    return [];
  }

  documentStore.apply({
    type: "batch",
    label: "Ungroup",
    commands: groups.map((group) => ({
      type: "ungroup-nodes" as const,
      groupId: group.id,
    })),
  });

  return groups.flatMap((group) => group.children);
}

/**
 * Layers-panel move: reparent a unit into another container (artboard
 * top level or group), pruning any group chain the move leaves empty.
 * One undoable entry. Returns false when the move is not possible.
 */
export function moveUnitToContainer(
  nodeId: string,
  toContainerId: string,
  toIndex: number,
): boolean {
  const document = documentStore.document;
  const node = documentStore.document.nodes[nodeId];
  const fromContainerId = findContainerId(document, nodeId);
  if (
    !node ||
    !fromContainerId ||
    (getClippingMaskOwnerId(document, nodeId) !== null &&
      toContainerId !== fromContainerId) ||
    nodeId === toContainerId ||
    collectSubtreeIds(document, nodeId).includes(toContainerId)
  ) {
    return false;
  }

  const move = {
    type: "move-node" as const,
    nodeId,
    toContainerId,
    toIndex,
  };

  const sourceGroup = document.nodes[fromContainerId];
  if (
    sourceGroup?.type === "group" &&
    sourceGroup.clippingMaskId !== undefined &&
    nodeId !== sourceGroup.clippingMaskId &&
    sourceGroup.children.every(
      (childId) =>
        childId === nodeId || childId === sourceGroup.clippingMaskId,
    )
  ) {
    // The last content leaving a clipping group would leave a blank structural
    // shell. Release the remaining path into the old parent in the same undo.
    documentStore.apply({
      type: "batch",
      label: "Move last clipped object",
      commands: [move, { type: "ungroup-nodes", groupId: sourceGroup.id }],
    });
    return true;
  }

  // Groups emptied by the move (walking up from the source container,
  // stopping at the destination — it gains the node and stays alive).
  const doomed: string[] = [];
  let current: string | null = fromContainerId;
  let removedChildId = nodeId;
  while (current && current !== toContainerId) {
    const container = document.nodes[current];
    if (
      container?.type !== "group" ||
      container.children.some((id) => id !== removedChildId)
    ) {
      break;
    }
    doomed.push(current);
    removedChildId = current;
    current = findContainerId(document, current);
  }

  documentStore.apply(
    doomed.length > 0
      ? {
          type: "batch",
          label: "Move layer",
          commands: [move, { type: "delete-nodes", nodeIds: doomed }],
        }
      : move,
  );
  return true;
}

/** Delete units plus any groups the deletion empties, as one entry. */
export function deleteSelection(selectedNodeIds: readonly string[]): void {
  const document = documentStore.document;
  const nodeIds = expandDeletionSet(document, selectedNodeIds);
  if (nodeIds.length > 0) {
    // Deleting a clipping path releases its owner first, then removes only
    // the requested path. One batch keeps the masked content and makes undo
    // restore both the path and its exact ownership relationship.
    const selected = new Set(selectedNodeIds);
    const maskOwners = [
      ...new Set(
        selectedNodeIds
          .map((nodeId) => getClippingMaskOwnerId(document, nodeId))
          .filter((id): id is string => id !== null && !selected.has(id)),
      ),
    ];
    const exhaustedOwners = Object.values(document.nodes)
      .filter(
        (node): node is GroupNode =>
          node.type === "group" &&
          node.clippingMaskId !== undefined &&
          !nodeIds.includes(node.id),
      )
      .filter((group) => {
        const contentIds = group.children.filter(
          (childId) => childId !== group.clippingMaskId,
        );
        return (
          contentIds.length > 0 &&
          contentIds.every((childId) => nodeIds.includes(childId))
        );
      })
      .map((group) => group.id);
    const owners = [...new Set([...maskOwners, ...exhaustedOwners])];
    documentStore.apply(
      owners.length === 0
        ? { type: "delete-nodes", nodeIds }
        : {
            type: "batch",
            label: "Delete clipping path",
            commands: [
              ...owners.map((groupId) => ({
                type: "ungroup-nodes" as const,
                groupId,
              })),
              { type: "delete-nodes", nodeIds },
            ],
          },
    );
  }
}

function boundsOfUnits(
  document: LogoDocument,
  ids: readonly string[],
): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const bounds = unitBounds(document, id);
    if (!bounds) {
      continue;
    }
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }
  return Number.isFinite(minX)
    ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    : null;
}

export { boundsOfUnits as selectionUnitBounds };

/**
 * Deep-clone whole unit subtrees with fresh ids (children remapped).
 * Returns every cloned node plus the clone roots, insertion-ready for
 * a single insert-nodes command.
 */
export function cloneUnits(
  document: LogoDocument,
  unitIds: readonly string[],
  offset = 0,
): { nodes: LogoNode[]; rootIds: string[] } {
  const sourceIds: string[] = [];
  const seen = new Set<string>();
  const collectSubtree = (id: string): void => {
    if (seen.has(id)) {
      return;
    }
    const node = document.nodes[id];
    if (!node) {
      return;
    }
    seen.add(id);
    if (node.type === "group") {
      node.children.forEach(collectSubtree);
    }
    sourceIds.push(id);
  };

  for (const id of unitIds) {
    collectSubtree(id);
  }

  const idMap = new Map(
    sourceIds.map((id) => {
      const node = document.nodes[id]!;
      return [id, createId(node.type === "group" ? "group" : "node")] as const;
    }),
  );
  const nodes = sourceIds.map((id) => {
    const clone = structuredClone(document.nodes[id]!) as LogoNode;
    clone.id = idMap.get(id)!;
    if (clone.type === "group") {
      clone.children = clone.children.flatMap((childId) => {
        const mapped = idMap.get(childId);
        return mapped ? [mapped] : [];
      });
      if (clone.clippingMaskId) {
        const mappedMask = idMap.get(clone.clippingMaskId);
        if (mappedMask) {
          clone.clippingMaskId = mappedMask;
        } else {
          delete clone.clippingMaskId;
        }
      }
    } else {
      clone.x += offset;
      clone.y += offset;
      if (clone.type === "text" && clone.onPath) {
        const mappedPath = idMap.get(clone.onPath.pathId);
        if (mappedPath) {
          clone.onPath = { ...clone.onPath, pathId: mappedPath };
        } else {
          delete clone.onPath;
        }
      }
    }
    return clone;
  });
  const rootIds = unitIds.flatMap((id) => {
    const mapped = idMap.get(id);
    return mapped ? [mapped] : [];
  });

  return { nodes, rootIds };
}

/** Order unit ids by full-scene traversal order (stable z for copy). */
export function sortBySceneOrder(
  document: LogoDocument,
  unitIds: readonly string[],
): string[] {
  const order: string[] = [];
  const visit = (id: string) => {
    order.push(id);
    const node = document.nodes[id];
    if (node?.type === "group") {
      node.children.forEach(visit);
    }
  };
  for (const artboard of document.artboards) {
    artboard.nodeIds.forEach(visit);
  }
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...unitIds].sort(
    (a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity),
  );
}

/**
 * Set a unit's derived bounds: translate + scale its leaves so the unit
 * lands on `next`. Works for groups and leaves alike.
 */
export function setUnitBounds(unitId: string, next: Partial<Bounds>): void {
  const document = documentStore.document;
  const bounds = unitBounds(document, unitId);
  if (!bounds) {
    return;
  }

  const target: Bounds = {
    x: next.x ?? bounds.x,
    y: next.y ?? bounds.y,
    width: Math.max(1, next.width ?? bounds.width),
    height: Math.max(1, next.height ?? bounds.height),
  };
  const sx = target.width / bounds.width;
  const sy = target.height / bounds.height;

  const updates = collectLeafNodeIds(document, [unitId])
    .map((nodeId) => {
      const node = document.nodes[nodeId];
      if (!node || node.locked) {
        return null;
      }
      const patch: NodePatch = {
        x: target.x + (node.x - bounds.x) * sx,
        y: target.y + (node.y - bounds.y) * sy,
        width: Math.max(1, node.width * sx),
        height: Math.max(1, node.height * sy),
      };
      if (node.type === "text" && sy !== 1) {
        patch.fontSize = Math.max(6, node.fontSize * sy);
      }
      return { nodeId, patch };
    })
    .filter((update): update is NonNullable<typeof update> => update !== null);

  if (updates.length > 0) {
    documentStore.apply({ type: "update-nodes", updates });
  }
}

/** Rotate a unit's leaves by `degrees` around the unit's centre. */
export function rotateUnitBy(unitId: string, degrees: number): void {
  const document = documentStore.document;
  const bounds = unitBounds(document, unitId);
  if (!bounds || degrees === 0) {
    return;
  }

  const pivot = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };

  const updates = collectLeafNodeIds(document, [unitId])
    .map((nodeId) => {
      const node = document.nodes[nodeId];
      if (!node || node.locked) {
        return null;
      }
      const center = rotatePoint(
        { x: node.x + node.width / 2, y: node.y + node.height / 2 },
        pivot,
        degrees,
      );
      return {
        nodeId,
        patch: {
          x: center.x - node.width / 2,
          y: center.y - node.height / 2,
          rotation: node.rotation + degrees,
        } as NodePatch,
      };
    })
    .filter((update): update is NonNullable<typeof update> => update !== null);

  if (updates.length > 0) {
    documentStore.apply({ type: "update-nodes", updates });
  }
}
