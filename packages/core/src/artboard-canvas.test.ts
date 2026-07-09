import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import { createArtboard, createInitialDocument } from "./factory";
import { ARTBOARD_GAP, nextArtboardPosition } from "./queries";
import type { LogoDocument } from "./types";

function docWithBoards(
  boards: Array<{ x: number; y: number; width: number; height: number }>,
): LogoDocument {
  const doc = createInitialDocument();
  const artboards = boards.map((box, index) =>
    createArtboard("primary", {
      name: `Board ${index}`,
      ...box,
      nodeIds: index === 0 ? doc.artboards[0]!.nodeIds : [],
    }),
  );
  return { ...doc, artboards, activeArtboardId: artboards[0]!.id };
}

describe("nextArtboardPosition", () => {
  it("places the new board right of the anchor with a gap, at its y", () => {
    const doc = docWithBoards([{ x: 100, y: 60, width: 720, height: 420 }]);
    expect(
      nextArtboardPosition(doc, doc.artboards[0]!.id, {
        width: 300,
        height: 250,
      }),
    ).toEqual({ x: 100 + 720 + ARTBOARD_GAP, y: 60 });
  });

  it("anchors to the given board, not the rightmost one", () => {
    const doc = docWithBoards([
      { x: 0, y: 0, width: 400, height: 300 },
      { x: 5000, y: 0, width: 400, height: 300 },
    ]);
    expect(
      nextArtboardPosition(doc, doc.artboards[0]!.id, {
        width: 200,
        height: 200,
      }),
    ).toEqual({ x: 400 + ARTBOARD_GAP, y: 0 });
  });

  it("pushes right past boards it would overlap", () => {
    const anchor = { x: 0, y: 0, width: 400, height: 300 };
    const blocker = {
      x: 400 + ARTBOARD_GAP + 100,
      y: 0,
      width: 400,
      height: 300,
    };
    const doc = docWithBoards([anchor, blocker]);
    expect(
      nextArtboardPosition(doc, doc.artboards[0]!.id, {
        width: 300,
        height: 300,
      }),
    ).toEqual({ x: blocker.x + blocker.width + ARTBOARD_GAP, y: 0 });
  });

  it("ignores boards on a different row", () => {
    const doc = docWithBoards([
      { x: 0, y: 0, width: 400, height: 300 },
      { x: 400 + ARTBOARD_GAP, y: 2000, width: 400, height: 300 },
    ]);
    expect(
      nextArtboardPosition(doc, doc.artboards[0]!.id, {
        width: 300,
        height: 300,
      }),
    ).toEqual({ x: 400 + ARTBOARD_GAP, y: 0 });
  });
});

describe("update-artboard canvas position", () => {
  it("repositions with an exact inverse", () => {
    const doc = docWithBoards([{ x: 10, y: 20, width: 720, height: 420 }]);
    const artboardId = doc.artboards[0]!.id;

    const moved = applyCommand(doc, {
      type: "update-artboard",
      artboardId,
      patch: { x: 640, y: -80 },
    });
    expect(moved.document.artboards[0]).toMatchObject({ x: 640, y: -80 });

    const undone = applyCommand(moved.document, moved.inverse);
    expect(undone.document).toEqual(doc);
  });
});
