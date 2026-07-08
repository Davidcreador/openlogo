import {
  type LogoNode,
  createId,
  getActiveArtboard,
} from "@openlogo/core";
import { documentStore } from "../state/document";

/**
 * Internal clipboard for logo nodes. App-local (not the OS clipboard):
 * nodes are structured data and cross-app paste has no meaning yet.
 */
let clipboard: LogoNode[] = [];
let pasteCount = 0;

const PASTE_OFFSET = 12;

/** Copy in z-order so paste preserves stacking. */
export function copyNodes(nodeIds: readonly string[]): number {
  const document = documentStore.document;
  const artboard = getActiveArtboard(document);
  const wanted = new Set(nodeIds);

  clipboard = artboard.nodeIds
    .filter((id) => wanted.has(id))
    .map((id) => document.nodes[id])
    .filter((node): node is LogoNode => Boolean(node))
    .map((node) => structuredClone(node));
  pasteCount = 0;

  return clipboard.length;
}

export function cutNodes(nodeIds: readonly string[]): number {
  const copied = copyNodes(nodeIds);
  if (copied > 0) {
    documentStore.apply({ type: "delete-nodes", nodeIds: [...nodeIds] });
  }
  return copied;
}

/** Paste clones with a cascading offset. Returns new ids for selection. */
export function pasteNodes(): string[] {
  if (clipboard.length === 0) {
    return [];
  }

  pasteCount += 1;
  const offset = PASTE_OFFSET * pasteCount;
  const clones = clipboard.map((node) => ({
    ...structuredClone(node),
    id: createId("node"),
    x: node.x + offset,
    y: node.y + offset,
  }));

  documentStore.apply({
    type: "insert-nodes",
    artboardId: documentStore.document.activeArtboardId,
    nodes: clones,
  });

  return clones.map((node) => node.id);
}

/** ⌘D: copy + paste in one step, offset once from the source. */
export function duplicateNodes(nodeIds: readonly string[]): string[] {
  const document = documentStore.document;
  const artboard = getActiveArtboard(document);
  const wanted = new Set(nodeIds);

  const clones = artboard.nodeIds
    .filter((id) => wanted.has(id))
    .map((id) => document.nodes[id])
    .filter((node): node is LogoNode => Boolean(node))
    .map((node) => ({
      ...structuredClone(node),
      id: createId("node"),
      x: node.x + PASTE_OFFSET,
      y: node.y + PASTE_OFFSET,
    }));

  if (clones.length === 0) {
    return [];
  }

  documentStore.apply({
    type: "insert-nodes",
    artboardId: documentStore.document.activeArtboardId,
    nodes: clones,
  });

  return clones.map((node) => node.id);
}
