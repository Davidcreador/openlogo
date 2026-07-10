import {
  type GroupNode,
  type LogoDocument,
  type LogoNode,
  collectSubtreeIds,
  createGroup,
  findContainerId,
  getContainerChildIds,
  getParentGroupId,
} from "@openlogo/core";
import { documentStore } from "../state/document";
import { selectionUnitBounds } from "./group-ops";

type ClippingPathNode = Extract<
  LogoNode,
  { type: "rectangle" | "ellipse" | "path" }
>;

export type ClippingMaskFailure =
  | "selection"
  | "mixed-containers"
  | "locked"
  | "nested-mask"
  | "text-path"
  | "preview-active";

type ResolvedMaskSelection = {
  containerId: string;
  orderedIds: string[];
  clippingPath: ClippingPathNode;
  insertIndex: number;
};

export type ClippingMaskAvailability =
  | { ok: true; value: ResolvedMaskSelection }
  | { ok: false; reason: ClippingMaskFailure };

function isClippingPath(
  node: LogoNode | undefined,
): node is ClippingPathNode {
  return (
    node?.type === "rectangle" ||
    node?.type === "ellipse" ||
    node?.type === "path"
  );
}

function hasLockedAncestor(document: LogoDocument, nodeId: string): boolean {
  const seen = new Set<string>();
  let parentId = getParentGroupId(document, nodeId);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = document.nodes[parentId];
    if (parent?.type !== "group" || parent.locked) {
      return true;
    }
    parentId = getParentGroupId(document, parentId);
  }
  return parentId !== null;
}

function hasTextPathIdentity(
  document: LogoDocument,
  selectedIds: readonly string[],
): boolean {
  const subtreeIds = new Set(
    selectedIds.flatMap((nodeId) => collectSubtreeIds(document, nodeId)),
  );

  // TextPathAttachment currently identifies only a path node, not a stable
  // subpath. Moving either endpoint into mask ownership is therefore rejected
  // until that identity can be preserved across future path operations.
  return Object.values(document.nodes).some(
    (node) =>
      node.type === "text" &&
      node.onPath !== undefined &&
      (subtreeIds.has(node.id) || subtreeIds.has(node.onPath.pathId)),
  );
}

export function inspectClippingMaskSelection(
  document: LogoDocument,
  selectedNodeIds: readonly string[],
): ClippingMaskAvailability {
  const uniqueIds = [...new Set(selectedNodeIds)];
  if (uniqueIds.length < 2 || uniqueIds.length !== selectedNodeIds.length) {
    return { ok: false, reason: "selection" };
  }

  const nodes = uniqueIds.map((id) => document.nodes[id]);
  if (nodes.some((node) => !node)) {
    return { ok: false, reason: "selection" };
  }
  if (
    nodes.some(
      (node) => node!.locked || hasLockedAncestor(document, node!.id),
    )
  ) {
    return { ok: false, reason: "locked" };
  }

  const containerIds = new Set(
    uniqueIds.map((id) => findContainerId(document, id)),
  );
  const containerId = [...containerIds][0];
  if (containerIds.size !== 1 || !containerId) {
    return { ok: false, reason: "mixed-containers" };
  }

  const siblings = getContainerChildIds(document, containerId);
  const selected = new Set(uniqueIds);
  const orderedIds = siblings.filter((id) => selected.has(id));
  if (orderedIds.length !== uniqueIds.length) {
    return { ok: false, reason: "mixed-containers" };
  }

  const clippingPathId = [...orderedIds]
    .reverse()
    .find((id) => isClippingPath(document.nodes[id]));
  const clippingPath = clippingPathId
    ? document.nodes[clippingPathId]
    : undefined;
  if (!isClippingPath(clippingPath)) {
    return { ok: false, reason: "selection" };
  }

  const owner = getParentGroupId(document, clippingPath.id);
  if (
    owner &&
    document.nodes[owner]?.type === "group" &&
    (document.nodes[owner] as GroupNode).clippingMaskId === clippingPath.id
  ) {
    return { ok: false, reason: "nested-mask" };
  }
  if (hasTextPathIdentity(document, orderedIds)) {
    return { ok: false, reason: "text-path" };
  }

  const indices = orderedIds.map((id) => siblings.indexOf(id));
  return {
    ok: true,
    value: {
      containerId,
      orderedIds,
      clippingPath,
      // Take the topmost selected object's post-removal stack position.
      insertIndex: Math.max(...indices) - (orderedIds.length - 1),
    },
  };
}

export function canMakeClippingMask(
  selectedNodeIds: readonly string[],
): boolean {
  return inspectClippingMaskSelection(
    documentStore.document,
    selectedNodeIds,
  ).ok;
}

/**
 * Make one clipping group without flattening any source. Validation finishes
 * before the single command runs, so every rejected case preserves originals.
 */
export function makeClippingMask(
  selectedNodeIds: readonly string[],
): string | null {
  const document = documentStore.document;
  if (document !== documentStore.committedDocument) {
    return null;
  }
  const resolved = inspectClippingMaskSelection(document, selectedNodeIds);
  if (!resolved.ok) {
    return null;
  }

  const group = createGroup(
    resolved.value.orderedIds,
    selectionUnitBounds(document, resolved.value.orderedIds),
  );
  group.name = "Clipping group";
  group.clippingMaskId = resolved.value.clippingPath.id;

  documentStore.apply({
    type: "group-nodes",
    containerId: resolved.value.containerId,
    group,
    index: resolved.value.insertIndex,
  });

  const committed = documentStore.document.nodes[group.id];
  return committed?.type === "group" &&
    committed.clippingMaskId === resolved.value.clippingPath.id
    ? group.id
    : null;
}

export function canReleaseClippingMask(
  selectedNodeIds: readonly string[],
): boolean {
  if (selectedNodeIds.length !== 1) {
    return false;
  }
  const node = documentStore.document.nodes[selectedNodeIds[0]!];
  return (
    node?.type === "group" &&
    node.clippingMaskId !== undefined &&
    !node.locked &&
    !hasLockedAncestor(documentStore.document, node.id)
  );
}

/** Release one clipping group as one undoable ungroup operation. */
export function releaseClippingMask(
  selectedNodeIds: readonly string[],
): string[] | null {
  if (
    documentStore.document !== documentStore.committedDocument ||
    !canReleaseClippingMask(selectedNodeIds)
  ) {
    return null;
  }
  const group = documentStore.document.nodes[selectedNodeIds[0]!] as GroupNode;
  const children = [...group.children];
  documentStore.apply({ type: "ungroup-nodes", groupId: group.id });
  return documentStore.document.nodes[group.id] ? null : children;
}

export function clippingMaskFailureMessage(
  selectedNodeIds: readonly string[],
): string {
  if (documentStore.document !== documentStore.committedDocument) {
    return "Finish the active edit before making a clipping mask.";
  }
  const result = inspectClippingMaskSelection(
    documentStore.document,
    selectedNodeIds,
  );
  if (result.ok) {
    return "Clipping mask could not be created. The original objects were preserved.";
  }
  return {
    selection: "Select at least two sibling objects, including a vector shape for the clipping path.",
    "mixed-containers": "Clipping-mask objects must be siblings in the same group or artboard.",
    locked: "Unlock the selected objects and their containing groups first.",
    "nested-mask": "Release the existing clipping mask before reusing its clipping path.",
    "text-path": "Detach type from its path before making that path part of a clipping mask.",
    "preview-active": "Finish the active edit before making a clipping mask.",
  }[result.reason];
}
