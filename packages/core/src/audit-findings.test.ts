import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import {
  cloneArtboardForVariant,
  createArtboard,
  createGroup,
  createInitialDocument,
  createRectangle,
} from "./factory";
import {
  collectSubtreeIds,
  getActiveArtboard,
  getRenderNodesForArtboard,
  unitBounds,
} from "./queries";
import { parseDocument } from "./schema";
import { computeSpacingSnap, measureDistances } from "./snapping";
import { insertAnchor, removeAnchor } from "./path-data";
import type { GroupNode, LogoDocument } from "./types";

/**
 * AUDIT findings, now fixed — every test here started life as a bug
 * repro (originally `it.fails`) or a coverage probe from the adversarial
 * audit. They assert the CORRECT behaviour and must stay green.
 */

function docWithThreeArtboards(): LogoDocument {
  let doc = createInitialDocument();
  const b = createArtboard("icon", { name: "B" });
  const c = createArtboard("wordmark", { name: "C" });
  doc = applyCommand(doc, { type: "add-artboard", artboard: b, nodes: [] }).document;
  doc = applyCommand(doc, { type: "add-artboard", artboard: c, nodes: [] }).document;
  return doc;
}

describe("AUDIT: artboard command inverses", () => {
  it("undo of remove-artboard restores the artboard at its original position", () => {
    const doc = docWithThreeArtboards();
    const [first] = doc.artboards;
    const removed = applyCommand(doc, {
      type: "remove-artboard",
      artboardId: first!.id,
    });
    const undone = applyCommand(removed.document, removed.inverse);

    expect(undone.document.artboards.map((a) => a.id)).toEqual(
      doc.artboards.map((a) => a.id),
    );
  });

  it("undo of remove-artboard(non-active) leaves activeArtboardId alone", () => {
    const doc = docWithThreeArtboards(); // active = C (last added)
    const [first] = doc.artboards;
    expect(doc.activeArtboardId).not.toBe(first!.id);

    const removed = applyCommand(doc, {
      type: "remove-artboard",
      artboardId: first!.id,
    });
    expect(removed.document.activeArtboardId).toBe(doc.activeArtboardId);

    const undone = applyCommand(removed.document, removed.inverse);
    expect(undone.document.activeArtboardId).toBe(doc.activeArtboardId);
  });

  it("undo of add-artboard restores the previously active artboard", () => {
    const doc = docWithThreeArtboards(); // active = C
    const added = applyCommand(doc, {
      type: "add-artboard",
      artboard: createArtboard("stacked", { name: "D" }),
      nodes: [],
    });
    const undone = applyCommand(added.document, added.inverse);
    expect(undone.document.activeArtboardId).toBe(doc.activeArtboardId);
  });

  it("undo of remove-artboard(active) restores it as active again", () => {
    const doc = docWithThreeArtboards(); // active = C
    const removed = applyCommand(doc, {
      type: "remove-artboard",
      artboardId: doc.activeArtboardId,
    });
    expect(removed.document.activeArtboardId).not.toBe(doc.activeArtboardId);
    const undone = applyCommand(removed.document, removed.inverse);
    expect(undone.document.activeArtboardId).toBe(doc.activeArtboardId);
  });

  it("remove-artboard deletes grouped children (no orphans left in nodes)", () => {
    let doc = docWithThreeArtboards();
    const target = doc.artboards[1]!;
    const child1 = createRectangle({ x: 0, y: 0 });
    const child2 = createRectangle({ x: 50, y: 0 });
    doc = applyCommand(doc, {
      type: "insert-nodes",
      artboardId: target.id,
      nodes: [child1, child2],
    }).document;
    const group = createGroup([child1.id, child2.id]);
    doc = applyCommand(doc, {
      type: "group-nodes",
      containerId: target.id,
      group,
      index: 0,
    }).document;

    const removal = applyCommand(doc, {
      type: "remove-artboard",
      artboardId: target.id,
    });

    expect(removal.document.nodes[child1.id]).toBeUndefined();
    expect(removal.document.nodes[child2.id]).toBeUndefined();
    expect(removal.document.nodes[group.id]).toBeUndefined();

    // And the inverse restores the whole subtree.
    const undone = applyCommand(removal.document, removal.inverse).document;
    expect(undone.nodes[child1.id]).toBeDefined();
    expect(undone.nodes[child2.id]).toBeDefined();
    expect((undone.nodes[group.id] as GroupNode).children).toEqual([
      child1.id,
      child2.id,
    ]);
  });
});

describe("AUDIT: variant cloning vs groups", () => {
  it("cloneArtboardForVariant deep-clones group subtrees with fresh ids", () => {
    let doc = createInitialDocument();
    const artboard = getActiveArtboard(doc);
    const [a, b] = artboard.nodeIds;
    const group = createGroup([a!, b!]);
    doc = applyCommand(doc, {
      type: "group-nodes",
      containerId: artboard.id,
      group,
      index: 0,
    }).document;

    const { artboard: variant, nodes } = cloneArtboardForVariant(
      doc,
      artboard.id,
      "icon",
    );
    const clonedGroup = nodes.find((n) => n.type === "group") as GroupNode;

    expect(clonedGroup).toBeDefined();
    // Cloned group must reference freshly cloned children, never the
    // source artboard's nodes — and every child must ride along.
    const cloneIds = new Set(nodes.map((n) => n.id));
    for (const childId of clonedGroup.children) {
      expect(doc.nodes[childId]).toBeUndefined();
      expect(cloneIds.has(childId)).toBe(true);
    }
    expect(clonedGroup.children).toHaveLength(2);
    // Roots listed on the variant artboard, subtree nodes only in `nodes`.
    expect(variant.nodeIds).toContain(clonedGroup.id);
    expect(variant.nodeIds).toHaveLength(2); // group + remaining loose node
    expect(nodes).toHaveLength(4); // group + 2 children + loose node
  });
});

describe("AUDIT: cyclic/corrupt documents are repaired at load and never crash queries", () => {
  function cyclicDoc(): { doc: LogoDocument; groupId: string } {
    const base = createInitialDocument();
    const artboard = getActiveArtboard(base);
    const group = createGroup([artboard.nodeIds[0]!]);
    const cyclic: LogoDocument = {
      ...base,
      nodes: {
        ...base.nodes,
        [group.id]: { ...group, children: [group.id] }, // self-cycle
      },
      artboards: base.artboards.map((a) => ({
        ...a,
        nodeIds: [...a.nodeIds, group.id],
      })),
    };
    return { doc: cyclic, groupId: group.id };
  }

  it("parseDocument cuts group cycles instead of letting them crash the app", () => {
    const { doc, groupId } = cyclicDoc();
    const parsed = parseDocument(JSON.parse(JSON.stringify(doc)));
    const group = parsed.nodes[groupId] as GroupNode;
    expect(group.children).toEqual([]); // self-reference dropped
    expect(() => getRenderNodesForArtboard(parsed)).not.toThrow();
  });

  it("tree queries are cycle-safe even on unsanitized documents", () => {
    const { doc, groupId } = cyclicDoc();
    expect(collectSubtreeIds(doc, groupId)).toEqual([groupId]);
    expect(unitBounds(doc, groupId)).toBeNull();
    expect(() => getRenderNodesForArtboard(doc)).not.toThrow();
  });

  it("two-group cycles are cut too", () => {
    const base = createInitialDocument();
    const g1 = createGroup([]);
    const g2 = createGroup([]);
    const doc: LogoDocument = {
      ...base,
      nodes: {
        ...base.nodes,
        [g1.id]: { ...g1, children: [g2.id] },
        [g2.id]: { ...g2, children: [g1.id] },
      },
      artboards: base.artboards.map((a) => ({
        ...a,
        nodeIds: [...a.nodeIds, g1.id],
      })),
    };
    const parsed = parseDocument(JSON.parse(JSON.stringify(doc)));
    expect((parsed.nodes[g1.id] as GroupNode).children).toEqual([g2.id]);
    expect((parsed.nodes[g2.id] as GroupNode).children).toEqual([]); // cycle edge cut
    expect(() => getRenderNodesForArtboard(parsed)).not.toThrow();
    expect(collectSubtreeIds(parsed, g1.id).sort()).toEqual(
      [g1.id, g2.id].sort(),
    );
  });

  it("parseDocument repairs a dangling activeArtboardId", () => {
    const base = createInitialDocument();
    const corrupt = { ...base, activeArtboardId: "artboard_gone" };
    const parsed = parseDocument(JSON.parse(JSON.stringify(corrupt)));
    expect(parsed.activeArtboardId).toBe(base.artboards[0]!.id);
    expect(() => getActiveArtboard(parsed)).not.toThrow();
  });

  it("parseDocument drops dangling references and prunes unreachable nodes", () => {
    const base = createInitialDocument();
    const artboard = getActiveArtboard(base);
    const orphan = createRectangle({ x: 0, y: 0 });
    const corrupt: LogoDocument = {
      ...base,
      nodes: { ...base.nodes, [orphan.id]: orphan }, // unreachable
      artboards: base.artboards.map((a) => ({
        ...a,
        nodeIds: [...a.nodeIds, "node_missing"], // dangling ref
      })),
    };
    const parsed = parseDocument(JSON.parse(JSON.stringify(corrupt)));
    expect(parsed.nodes[orphan.id]).toBeUndefined();
    expect(getActiveArtboard(parsed).nodeIds).toEqual(artboard.nodeIds);
  });

  it("parseDocument keeps intact documents byte-identical", () => {
    const doc = createInitialDocument();
    const parsed = parseDocument(JSON.parse(JSON.stringify(doc)));
    expect(parsed).toEqual(doc);
  });
});

describe("AUDIT coverage: probes that held up", () => {
  it("insertAnchor at t=0 and t=1 on a cubic stays finite and shape-preserving", () => {
    const geometry = {
      subpaths: [
        {
          closed: false,
          points: [
            { x: 0, y: 0, handleOut: { x: 10, y: -20 } },
            { x: 100, y: 0, handleIn: { x: 90, y: -20 } },
          ],
        },
      ],
    };
    for (const t of [0, 1, 1e-9, 1 - 1e-9]) {
      const result = insertAnchor(geometry, 0, 0, t);
      expect(result).not.toBeNull();
      const flat = JSON.stringify(result);
      expect(flat).not.toContain("NaN");
      expect(flat).not.toContain("null");
      expect(result!.geometry.subpaths[0]!.points).toHaveLength(3);
    }
  });

  it("insertAnchor on the closing segment of a closed subpath appends correctly", () => {
    const geometry = {
      subpaths: [
        {
          closed: true,
          points: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
            { x: 50, y: 80 },
          ],
        },
      ],
    };
    // Closing segment: index 2 (points[2] -> points[0]).
    const result = insertAnchor(geometry, 0, 2, 0.5);
    expect(result).not.toBeNull();
    expect(result!.geometry.subpaths[0]!.points).toHaveLength(4);
    const inserted = result!.geometry.subpaths[0]!.points[3]!;
    expect(inserted.x).toBeCloseTo(25);
    expect(inserted.y).toBeCloseTo(40);
  });

  it("removeAnchor handles out-of-range indices and full collapse", () => {
    const geometry = {
      subpaths: [{ closed: false, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }],
    };
    expect(removeAnchor(geometry, 5, 0)).toBeNull();
    expect(removeAnchor(geometry, 0, 9)).toBeNull();
    // Removing from a 2-point subpath drops the subpath -> whole geometry gone.
    expect(removeAnchor(geometry, 0, 0)).toBeNull();
  });

  it("computeSpacingSnap: overlapping neighbours (negative gap) produce no snap", () => {
    const moving = { x: 55, y: 0, width: 30, height: 50 };
    const left = { x: 0, y: 0, width: 50, height: 50 };
    const rightOverlapping = { x: 70, y: 0, width: 50, height: 50 }; // gap would be negative
    expect(
      computeSpacingSnap(moving, [left, rightOverlapping], "x", 8),
    ).toBeNull();
  });

  it("computeSpacingSnap: zero-gap centring is offered and exact", () => {
    const moving = { x: 47, y: 0, width: 30, height: 50 };
    const left = { x: 0, y: 0, width: 50, height: 50 };
    const right = { x: 80, y: 0, width: 50, height: 50 };
    const snap = computeSpacingSnap(moving, [left, right], "x", 8);
    expect(snap).not.toBeNull();
    expect(snap!.delta).toBeCloseTo(3); // lands at x=50, gaps 0 and 0
    expect(snap!.gaps.every((g) => g.distance >= 0)).toBe(true);
  });

  it("computeSpacingSnap: rows of touching boxes extend with a zero gap", () => {
    // l2 [0..50] touching l [50..100]; moving near x=104 should snap to
    // x=100 (extend the row, repeating the 0 gap).
    const moving = { x: 104, y: 0, width: 30, height: 50 };
    const l2 = { x: 0, y: 0, width: 50, height: 50 };
    const l = { x: 50, y: 0, width: 50, height: 50 };
    const snap = computeSpacingSnap(moving, [l2, l], "x", 8);
    expect(snap).not.toBeNull();
    expect(snap!.delta).toBeCloseTo(-4);
    expect(snap!.gaps.every((g) => g.distance === 0)).toBe(true);
  });

  it("computeSpacingSnap: zero-thickness ruler-guide boxes are ignored", () => {
    const moving = { x: 40, y: 0, width: 30, height: 50 };
    const guideLine = { x: 40, y: -10000, width: 0, height: 20000 };
    expect(computeSpacingSnap(moving, [guideLine], "x", 8)).toBeNull();
    expect(measureDistances(moving, [guideLine])).toEqual([]);
  });

  it("computeSpacingSnap: a box containing the moving box never flanks it", () => {
    const moving = { x: 100, y: 100, width: 40, height: 40 };
    const artboardLike = { x: 0, y: 0, width: 720, height: 420 };
    expect(computeSpacingSnap(moving, [artboardLike], "x", 8)).toBeNull();
    expect(measureDistances(moving, [artboardLike])).toEqual([]);
  });

  it("measureDistances: identical stacked boxes measure nothing (no zero/negative segments)", () => {
    const moving = { x: 10, y: 10, width: 40, height: 40 };
    const twin = { x: 10, y: 10, width: 40, height: 40 };
    expect(measureDistances(moving, [twin])).toEqual([]);
  });

  it("v1 migration: self-referencing and dangling groupId tags are harmless", () => {
    const base = createInitialDocument();
    const artboard = getActiveArtboard(base);
    const [a, b, c] = artboard.nodeIds;
    const v1 = JSON.parse(JSON.stringify(base)) as LogoDocument;
    v1.schemaVersion = 1;
    // a: tag pointing "nowhere" shared with b -> becomes a real group.
    (v1.nodes[a!] as { groupId?: string }).groupId = "ghost-cluster";
    (v1.nodes[b!] as { groupId?: string }).groupId = "ghost-cluster";
    // c: self-referencing singleton tag -> must be dropped, not grouped.
    (v1.nodes[c!] as { groupId?: string }).groupId = c!;

    const migrated = parseDocument(JSON.parse(JSON.stringify(v1)));
    const groups = Object.values(migrated.nodes).filter((n) => n.type === "group");
    expect(groups).toHaveLength(1);
    expect((groups[0] as GroupNode).children.sort()).toEqual([a!, b!].sort());
    // No groupId tags survive.
    for (const node of Object.values(migrated.nodes)) {
      expect((node as { groupId?: string }).groupId).toBeUndefined();
    }
    // c stays a plain top-level node.
    expect(migrated.artboards[0]!.nodeIds).toContain(c!);
  });

  it("schema round-trip: initial document survives JSON + parseDocument exactly", () => {
    const doc = createInitialDocument();
    const roundTripped = parseDocument(JSON.parse(JSON.stringify(doc)));
    expect(roundTripped).toEqual(doc);
  });

  it("schema rejects zero/negative node sizes (loadDocument backs the payload up)", () => {
    const doc = createInitialDocument();
    const id = getActiveArtboard(doc).nodeIds[0]!;
    const corrupt = JSON.parse(JSON.stringify(doc)) as LogoDocument;
    (corrupt.nodes[id] as { width: number }).width = 0;
    // Schema-level failures still throw (sizes are not repairable), but
    // editor loadDocument now preserves the payload under a backup key
    // instead of silently letting the next autosave destroy it.
    expect(() => parseDocument(corrupt)).toThrow();
  });
});
