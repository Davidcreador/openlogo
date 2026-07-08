import { type LogoDocument, type LogoNode, createId } from "@openlogo/core";
import { cloneUnits, deleteSelection, sortBySceneOrder } from "./group-ops";
import { documentStore } from "../state/document";

/**
 * Internal clipboard for logo nodes. App-local (not the OS clipboard):
 * nodes are structured data and cross-app paste has no meaning yet.
 * Groups copy as whole subtrees; roots keep their relative z-order.
 */
let clipboard: { rootIds: string[]; nodes: LogoNode[] } | null = null;
let pasteCount = 0;

const PASTE_OFFSET = 12;

/** Copy unit subtrees in scene z-order so paste preserves stacking. */
export function copyNodes(nodeIds: readonly string[]): number {
  const document = documentStore.document;
  const ordered = sortBySceneOrder(
    document,
    nodeIds.filter((id) => document.nodes[id]),
  );

  clipboard = ordered.length > 0 ? cloneUnits(document, ordered) : null;
  pasteCount = 0;

  return clipboard?.rootIds.length ?? 0;
}

export function cutNodes(nodeIds: readonly string[]): number {
  const copied = copyNodes(nodeIds);
  if (copied > 0) {
    deleteSelection(nodeIds);
  }
  return copied;
}

/** Re-id a stored subtree so repeated pastes stay independent. */
function remapForInsert(
  source: { rootIds: string[]; nodes: LogoNode[] },
  offset: number,
): { rootIds: string[]; nodes: LogoNode[] } {
  const idMap = new Map<string, string>();
  for (const node of source.nodes) {
    idMap.set(
      node.id,
      createId(node.type === "group" ? "group" : "node"),
    );
  }

  const nodes = source.nodes.map((node) => {
    const clone = structuredClone(node) as LogoNode;
    clone.id = idMap.get(node.id)!;
    if (clone.type === "group") {
      clone.children = clone.children.map(
        (childId) => idMap.get(childId) ?? childId,
      );
    } else {
      clone.x += offset;
      clone.y += offset;
    }
    return clone;
  });

  return {
    nodes,
    rootIds: source.rootIds.map((id) => idMap.get(id)!),
  };
}

/** Paste clones with a cascading offset. Returns new root ids for selection. */
export function pasteNodes(): string[] {
  if (!clipboard) {
    return [];
  }

  pasteCount += 1;
  const { nodes, rootIds } = remapForInsert(
    clipboard,
    PASTE_OFFSET * pasteCount,
  );

  documentStore.apply({
    type: "insert-nodes",
    artboardId: documentStore.document.activeArtboardId,
    nodes,
  });

  return rootIds;
}

/** ⌘D: copy + paste in one step, offset once from the source. */
export function duplicateNodes(nodeIds: readonly string[]): string[] {
  const document: LogoDocument = documentStore.document;
  const ordered = sortBySceneOrder(
    document,
    nodeIds.filter((id) => document.nodes[id]),
  );
  if (ordered.length === 0) {
    return [];
  }

  const { nodes, rootIds } = cloneUnits(document, ordered, PASTE_OFFSET);

  documentStore.apply({
    type: "insert-nodes",
    artboardId: document.activeArtboardId,
    nodes,
  });

  return rootIds;
}
