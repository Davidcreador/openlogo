import {
  type GroupNode,
  createEllipse,
  createGroup,
  createInitialDocument,
  createPath,
  createRectangle,
  createText,
  getActiveArtboard,
} from "@openlogo/core";
import { beforeEach, describe, expect, it } from "vitest";
import { documentStore } from "../state/document";
import {
  canMakeClippingMask,
  canReleaseClippingMask,
  makeClippingMask,
  releaseClippingMask,
} from "./clipping-mask";
import {
  cloneUnits,
  deleteSelection,
  groupSelection,
  moveUnitToContainer,
} from "./group-ops";
import { documentToSvg, nodesToSvg } from "./export";
import { combinableNodes } from "./boolean-ops";
import { copyNodes, pasteNodes } from "./clipboard";

function fixture() {
  const document = createInitialDocument();
  const artboard = getActiveArtboard(document);
  const content = createRectangle({ x: 0, y: 0, fill: "#ef4444" });
  content.width = 180;
  content.height = 140;
  const mask = createEllipse({ x: 30, y: 20, fill: "#2563eb" });
  mask.width = 90;
  mask.height = 80;
  mask.opacity = 0.72;
  const label = createText({ x: 12, y: 12, content: "Inside" });
  document.nodes = {
    [content.id]: content,
    [mask.id]: mask,
    [label.id]: label,
  };
  artboard.nodeIds = [content.id, mask.id, label.id];
  return { document, artboard, content, mask, label };
}

beforeEach(() => {
  documentStore.reset(createInitialDocument());
});

describe("makeClippingMask", () => {
  it("uses the topmost selected path-like sibling and keeps sources editable", () => {
    const { document, content, mask, label } = fixture();
    documentStore.reset(document);

    expect(canMakeClippingMask([label.id, content.id, mask.id])).toBe(true);
    const groupId = makeClippingMask([label.id, content.id, mask.id]);
    expect(groupId).toBeTruthy();
    const group = documentStore.document.nodes[groupId!] as GroupNode;
    expect(group).toMatchObject({
      type: "group",
      name: "Clipping group",
      clippingMaskId: mask.id,
      children: [content.id, mask.id, label.id],
    });
    expect(documentStore.document.nodes[content.id]).toBeDefined();
    expect(documentStore.document.nodes[mask.id]).toMatchObject({
      fill: { type: "solid", color: "#2563eb" },
      opacity: 0.72,
    });

    documentStore.undo();
    expect(documentStore.document.nodes[groupId!]).toBeUndefined();
    expect(getActiveArtboard(documentStore.document).nodeIds).toEqual([
      content.id,
      mask.id,
      label.id,
    ]);
  });

  it("rejects mixed containers, locked ancestors, and text-path identities", () => {
    const { document, artboard, content, mask, label } = fixture();
    const holder = createGroup([mask.id]);
    document.nodes[holder.id] = holder;
    artboard.nodeIds = [content.id, holder.id, label.id];
    documentStore.reset(document);
    const before = documentStore.document;
    expect(makeClippingMask([content.id, mask.id])).toBeNull();
    expect(documentStore.document).toBe(before);

    holder.locked = true;
    holder.children = [content.id, mask.id];
    artboard.nodeIds = [holder.id, label.id];
    documentStore.reset(document);
    expect(makeClippingMask([content.id, mask.id])).toBeNull();

    holder.locked = false;
    label.onPath = { pathId: mask.id, startOffset: 0, flip: false };
    documentStore.reset(document);
    expect(makeClippingMask([content.id, mask.id])).toBeNull();
  });

  it("exports a standard user-space clipPath without painting the mask", () => {
    const { document, content, mask } = fixture();
    getActiveArtboard(document).nodeIds = [content.id, mask.id];
    delete document.nodes[Object.values(document.nodes).find(
      (node) => node.type === "text",
    )?.id ?? ""];
    documentStore.reset(document);
    const groupId = makeClippingMask([content.id, mask.id]);
    const svg = documentToSvg(documentStore.document);

    expect(groupId).toBeTruthy();
    expect(svg).toContain("<clipPath");
    expect(svg).toContain('clipPathUnits="userSpaceOnUse"');
    expect(svg).toMatch(/clip-path="url\(#clip-\d+\)"/);
    expect(svg.match(/<ellipse/g)).toHaveLength(1);
  });

  it("exports a compound clipping path with its explicit even-odd rule", () => {
    const { document, artboard, content } = fixture();
    const mask = createPath({
      x: 20,
      y: 20,
      d: "M 0 0 H 96 V 96 H 0 Z M 24 24 H 72 V 72 H 24 Z",
      fillRule: "evenodd",
    });
    document.nodes = { [content.id]: content, [mask.id]: mask };
    artboard.nodeIds = [content.id, mask.id];
    documentStore.reset(document);
    expect(makeClippingMask([content.id, mask.id])).toBeTruthy();
    expect(documentToSvg(documentStore.document)).toContain(
      'clip-rule="evenodd"',
    );
  });

  it("keeps rotated clipping content inside the selection export viewBox", () => {
    const { document, artboard, content, mask } = fixture();
    Object.assign(content, {
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      rotation: 90,
    });
    Object.assign(mask, {
      x: 10,
      y: -30,
      width: 80,
      height: 100,
      rotation: 90,
    });
    document.nodes = { [content.id]: content, [mask.id]: mask };
    artboard.nodeIds = [content.id, mask.id];
    documentStore.reset(document);
    const groupId = makeClippingMask([content.id, mask.id])!;

    const svg = nodesToSvg(documentStore.document, [groupId])!;
    const viewBox = svg
      .match(/viewBox="([^"]+)"/)![1]!
      .split(/\s+/)
      .map(Number);
    expect(viewBox[0]).toBeCloseTo(30, 6);
    expect(viewBox[1]).toBeCloseTo(-20, 6);
    expect(viewBox[2]).toBeCloseTo(40, 6);
    expect(viewBox[3]).toBeCloseTo(80, 6);
  });

  it("uses a rotated leaf's visual AABB for selection export", () => {
    const document = createInitialDocument();
    const artboard = getActiveArtboard(document);
    const rectangle = createRectangle({ x: 0, y: 0, fill: "#ef4444" });
    rectangle.width = 100;
    rectangle.height = 40;
    rectangle.rotation = 90;
    document.nodes = { [rectangle.id]: rectangle };
    artboard.nodeIds = [rectangle.id];

    const svg = nodesToSvg(document, [rectangle.id])!;
    const viewBox = svg
      .match(/viewBox="([^"]+)"/)![1]!
      .split(/\s+/)
      .map(Number);
    expect(viewBox[0]).toBeCloseTo(30, 6);
    expect(viewBox[1]).toBeCloseTo(-30, 6);
    expect(viewBox[2]).toBeCloseTo(40, 6);
    expect(viewBox[3]).toBeCloseTo(100, 6);
  });

  it("blocks flattening/reparenting operations that would orphan the mask", () => {
    const { document, content, mask } = fixture();
    documentStore.reset(document);
    const groupId = makeClippingMask([content.id, mask.id])!;
    expect(groupSelection([content.id, mask.id])).toBeNull();
    expect(combinableNodes([groupId])).toEqual([]);
  });
});

describe("releaseClippingMask", () => {
  it("releases to siblings and undo restores ownership", () => {
    const { document, content, mask } = fixture();
    documentStore.reset(document);
    const groupId = makeClippingMask([content.id, mask.id])!;
    expect(canReleaseClippingMask([groupId])).toBe(true);

    const children = releaseClippingMask([groupId]);
    expect(children).toEqual([content.id, mask.id]);
    expect(documentStore.document.nodes[groupId]).toBeUndefined();
    expect(documentStore.document.nodes[mask.id]).toMatchObject({
      fill: { type: "solid", color: "#2563eb" },
      opacity: 0.72,
    });

    documentStore.undo();
    expect(documentStore.document.nodes[groupId]).toMatchObject({
      type: "group",
      clippingMaskId: mask.id,
    });
  });

  it("deleting the clipping path releases content and undoes atomically", () => {
    const { document, content, mask } = fixture();
    documentStore.reset(document);
    const groupId = makeClippingMask([content.id, mask.id])!;

    deleteSelection([mask.id]);
    expect(documentStore.document.nodes[groupId]).toBeUndefined();
    expect(documentStore.document.nodes[mask.id]).toBeUndefined();
    expect(documentStore.document.nodes[content.id]).toBeDefined();

    documentStore.undo();
    expect(documentStore.document.nodes[groupId]).toMatchObject({
      clippingMaskId: mask.id,
    });
    expect(documentStore.document.nodes[mask.id]).toBeDefined();
  });

  it("releases the mask when the last content object is deleted", () => {
    const { document, content, mask } = fixture();
    documentStore.reset(document);
    const groupId = makeClippingMask([content.id, mask.id])!;

    deleteSelection([content.id]);
    expect(documentStore.document.nodes[groupId]).toBeUndefined();
    expect(documentStore.document.nodes[content.id]).toBeUndefined();
    expect(documentStore.document.nodes[mask.id]).toBeDefined();

    documentStore.undo();
    expect(documentStore.document.nodes[groupId]).toMatchObject({
      clippingMaskId: mask.id,
      children: [content.id, mask.id],
    });
  });

  it("releases the mask when the last content object moves out", () => {
    const { document, artboard, content, mask } = fixture();
    documentStore.reset(document);
    const groupId = makeClippingMask([content.id, mask.id])!;

    expect(moveUnitToContainer(content.id, artboard.id, 0)).toBe(true);
    expect(documentStore.document.nodes[groupId]).toBeUndefined();
    expect(documentStore.document.nodes[mask.id]).toBeDefined();
    expect(getActiveArtboard(documentStore.document).nodeIds).toContain(
      content.id,
    );

    documentStore.undo();
    expect(documentStore.document.nodes[groupId]).toMatchObject({
      clippingMaskId: mask.id,
      children: [content.id, mask.id],
    });
  });

  it("remaps ownership when cloning a clipping group", () => {
    const { document, content, mask } = fixture();
    documentStore.reset(document);
    const groupId = makeClippingMask([content.id, mask.id])!;
    const cloned = cloneUnits(documentStore.document, [groupId], 12);
    const group = cloned.nodes.find(
      (node): node is GroupNode => node.type === "group",
    )!;
    expect(group.clippingMaskId).toBeDefined();
    expect(group.children).toContain(group.clippingMaskId);
    expect(group.clippingMaskId).not.toBe(mask.id);
  });

  it("remaps ownership through copy and repeated paste", () => {
    const { document, content, mask } = fixture();
    documentStore.reset(document);
    const groupId = makeClippingMask([content.id, mask.id])!;
    expect(copyNodes([groupId])).toBe(1);

    const [pastedId] = pasteNodes();
    const pasted = documentStore.document.nodes[pastedId!] as GroupNode;
    expect(pasted.clippingMaskId).toBeDefined();
    expect(pasted.children).toContain(pasted.clippingMaskId);
    expect(pasted.clippingMaskId).not.toBe(mask.id);
  });
});
