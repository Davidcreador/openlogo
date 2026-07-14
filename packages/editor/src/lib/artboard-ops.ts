import { type Artboard, createArtboard } from "@openlogo/core";
import { documentStore } from "../state/document";
import { useEditorStore } from "../state/editor-store";

export type ArtboardSide = "left" | "right" | "top" | "bottom";

const GAP = 48;

/** Pan the camera just enough to bring the artboard into view. */
export function ensureArtboardVisible(artboardId: string): void {
  const state = useEditorStore.getState();
  const target = documentStore.document.artboards.find(
    (item) => item.id === artboardId,
  );
  if (!target || state.viewport.width === 0) {
    return;
  }

  const { camera, viewport } = state;
  const viewWidth = viewport.width / camera.zoom;
  const viewHeight = viewport.height / camera.zoom;
  const margin = 24 / camera.zoom;

  let ox = camera.offset.x;
  let oy = camera.offset.y;
  // Minimal nudge per axis; a board wider/taller than the viewport keeps
  // its near (top-left) edge visible.
  if (target.x - margin < ox) {
    ox = target.x - margin;
  } else if (target.x + target.width + margin > ox + viewWidth) {
    ox = Math.min(target.x - margin, target.x + target.width + margin - viewWidth);
  }
  if (target.y - margin < oy) {
    oy = target.y - margin;
  } else if (target.y + target.height + margin > oy + viewHeight) {
    oy = Math.min(target.y - margin, target.y + target.height + margin - viewHeight);
  }

  if (ox !== camera.offset.x || oy !== camera.offset.y) {
    state.setCamera({ ...camera, offset: { x: ox, y: oy } });
  }
}

function overlaps(a: Artboard, rect: { x: number; y: number; width: number; height: number }): boolean {
  return (
    a.x < rect.x + rect.width &&
    a.x + a.width > rect.x &&
    a.y < rect.y + rect.height &&
    a.y + a.height > rect.y
  );
}

/**
 * Add a new blank artboard of the same size directly beside `sourceId`
 * on the requested side (Figma-style edge "+"). Slides further along
 * that axis until the slot is free, activates the new board, and pans
 * it into view. Returns the new artboard id.
 */
export function addArtboardBeside(
  sourceId: string,
  side: ArtboardSide,
): string | null {
  const doc = documentStore.document;
  const source = doc.artboards.find((item) => item.id === sourceId);
  if (!source) {
    return null;
  }

  const step = {
    left: { x: -(source.width + GAP), y: 0 },
    right: { x: source.width + GAP, y: 0 },
    top: { x: 0, y: -(source.height + GAP) },
    bottom: { x: 0, y: source.height + GAP },
  }[side];

  const slot = {
    x: source.x + step.x,
    y: source.y + step.y,
    width: source.width,
    height: source.height,
  };
  // Slide along the axis until nothing occupies the slot.
  for (
    let i = 0;
    i < 100 && doc.artboards.some((board) => overlaps(board, slot));
    i += 1
  ) {
    slot.x += step.x;
    slot.y += step.y;
  }

  const board = createArtboard("primary", {
    name: `Artboard ${doc.artboards.length + 1}`,
    x: slot.x,
    y: slot.y,
    width: source.width,
    height: source.height,
    background: source.background,
  });
  documentStore.apply({ type: "add-artboard", artboard: board, nodes: [] });
  useEditorStore.getState().setSelection([]);
  ensureArtboardVisible(board.id);
  return board.id;
}
