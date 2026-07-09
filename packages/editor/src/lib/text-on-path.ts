import {
  type LogoDocument,
  type PathNode,
  type TextNode,
  pathGeometryLength,
} from "@openlogo/core";
import { documentStore } from "../state/document";
import { fontStore } from "./font-store";

/**
 * Type on a path (Illustrator's "type on a path"): the attachment lives
 * as `onPath` params on the TextNode, layout is derived at render time
 * by the Skia renderer. These helpers only patch the document — a single
 * update-nodes command each, so attach/detach/offset are exact-inverse
 * undo entries.
 */

export function isTextPathPair(
  document: LogoDocument,
  nodeIds: readonly string[],
): { text: TextNode; path: PathNode } | null {
  if (nodeIds.length !== 2) {
    return null;
  }
  const nodes = nodeIds.map((id) => document.nodes[id]);
  const text = nodes.find((node) => node?.type === "text") as
    | TextNode
    | undefined;
  const path = nodes.find((node) => node?.type === "path") as
    | PathNode
    | undefined;
  if (!text || !path || text.onPath) {
    return null;
  }
  return { text, path };
}

/**
 * Attach the text to the path. The text node's box is synced to the
 * path's box so selection/hit-testing lands where the glyphs are; while
 * attached, layout comes entirely from the path (x/y are not used).
 */
export function attachTextToPath(textId: string, pathId: string): void {
  const document = documentStore.document;
  const text = document.nodes[textId];
  const path = document.nodes[pathId];
  if (text?.type !== "text" || path?.type !== "path") {
    return;
  }

  // The renderer needs a per-weight Typeface for glyph layout; kick the
  // fetch off now (invalidate() re-renders when it lands).
  void fontStore.ensure(text.fontFamily, text.fontWeight);

  documentStore.apply({
    type: "update-nodes",
    updates: [
      {
        nodeId: textId,
        patch: {
          onPath: { pathId, startOffset: 0, flip: false },
          x: path.x,
          y: path.y,
          width: Math.max(1, path.width),
          height: Math.max(1, path.height),
        },
      },
    ],
  });
}

/** Detach: the text renders as a normal paragraph at its box again. */
export function detachTextFromPath(textId: string): void {
  const node = documentStore.document.nodes[textId];
  if (node?.type !== "text" || !node.onPath) {
    return;
  }
  documentStore.apply({
    type: "update-nodes",
    updates: [{ nodeId: textId, patch: { onPath: undefined } }],
  });
}

/**
 * Approximate rendered arc length of a path node (slider range for the
 * start offset). Uses the structured geometry when present; imported
 * `d`-only paths fall back to the box perimeter — a generous, harmless
 * overestimate for a slider max.
 */
export function pathNodeLength(document: LogoDocument, pathId: string): number {
  const node = document.nodes[pathId];
  if (node?.type !== "path") {
    return 0;
  }
  if (node.geometry) {
    return pathGeometryLength(
      node.geometry,
      node.width / node.intrinsicWidth,
      node.height / node.intrinsicHeight,
    );
  }
  return 2 * (node.width + node.height);
}
