import {
  createEllipse,
  createGroup,
  createInitialDocument,
  createRectangle,
  getActiveArtboard,
} from "@openlogo/core";
import { describe, expect, it, vi } from "vitest";
import { pointInsideClippingMasks } from "./renderer";

describe("pointInsideClippingMasks", () => {
  it("requires content hits to pass every nested clipping path", () => {
    const document = createInitialDocument();
    const artboard = getActiveArtboard(document);
    const content = createRectangle({ x: 0, y: 0 });
    const innerMask = createEllipse({ x: 10, y: 10 });
    const outerMask = createRectangle({ x: 5, y: 5 });
    const inner = createGroup([content.id, innerMask.id]);
    inner.clippingMaskId = innerMask.id;
    const outer = createGroup([inner.id, outerMask.id]);
    outer.clippingMaskId = outerMask.id;
    document.nodes = {
      [content.id]: content,
      [innerMask.id]: innerMask,
      [outerMask.id]: outerMask,
      [inner.id]: inner,
      [outer.id]: outer,
    };
    artboard.nodeIds = [outer.id];

    const contains = vi.fn((mask: { id: string }) => mask.id !== innerMask.id);
    expect(
      pointInsideClippingMasks(document, content.id, { x: 20, y: 20 }, contains),
    ).toBe(false);
    expect(contains).toHaveBeenCalledTimes(2);

    contains.mockImplementation(() => true);
    expect(
      pointInsideClippingMasks(document, content.id, { x: 20, y: 20 }, contains),
    ).toBe(true);
  });

  it("fails closed when ownership points at invalid geometry", () => {
    const document = createInitialDocument();
    const artboard = getActiveArtboard(document);
    const content = createRectangle({ x: 0, y: 0 });
    const group = createGroup([content.id]);
    group.clippingMaskId = "missing-mask";
    document.nodes = { [content.id]: content, [group.id]: group };
    artboard.nodeIds = [group.id];

    expect(
      pointInsideClippingMasks(
        document,
        content.id,
        { x: 10, y: 10 },
        () => true,
      ),
    ).toBe(false);
  });
});
