import { createInitialDocument, createRectangle } from "@openlogo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCanvasKit: vi.fn(),
  offsetNodePath: vi.fn(),
}));

vi.mock("./canvaskit", () => ({ getCanvasKit: mocks.getCanvasKit }));
vi.mock("@openlogo/renderer", () => ({
  offsetNodePath: mocks.offsetNodePath,
}));

import { offsetPathOp } from "./offset-path";
import { documentStore } from "../state/document";

describe("offset path async session safety", () => {
  beforeEach(() => {
    mocks.getCanvasKit.mockReset();
    mocks.offsetNodePath.mockReset();
  });

  it("does not insert stale geometry after the document is replaced", async () => {
    const source = createInitialDocument();
    const rectangle = createRectangle({ x: 10, y: 20 });
    source.nodes = { [rectangle.id]: rectangle };
    source.artboards[0] = {
      ...source.artboards[0]!,
      nodeIds: [rectangle.id],
    };
    documentStore.reset(source);

    let resolveCanvasKit!: (value: unknown) => void;
    mocks.getCanvasKit.mockReturnValue(
      new Promise((resolve) => {
        resolveCanvasKit = resolve;
      }),
    );
    mocks.offsetNodePath.mockReturnValue({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      d: "M 0 0 L 100 0 L 100 100 Z",
      fillRule: "nonzero",
      geometry: {
        subpaths: [
          {
            closed: true,
            points: [
              { x: 0, y: 0 },
              { x: 100, y: 0 },
              { x: 100, y: 100 },
            ],
          },
        ],
      },
    });

    const pending = offsetPathOp(rectangle.id, 10);
    const replacement = createInitialDocument();
    documentStore.reset(replacement);
    resolveCanvasKit({});

    await expect(pending).resolves.toBeNull();
    expect(documentStore.committedDocument).toBe(replacement);
    expect(
      Object.values(replacement.nodes).some((node) =>
        node.name.includes("offset"),
      ),
    ).toBe(false);
  });
});
