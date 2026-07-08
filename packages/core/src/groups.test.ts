import { describe, expect, it } from "vitest";
import { applyCommand } from "./commands";
import {
  createEllipse,
  createGroup,
  createInitialDocument,
  createRectangle,
} from "./factory";
import {
  collectLeafNodeIds,
  expandDeletionSet,
  findContainerId,
  getActiveArtboard,
  getRenderNodesForArtboard,
  unitBounds,
} from "./queries";
import { parseDocument } from "./schema";
import type { GroupNode, LogoDocument } from "./types";

/** Initial doc has 3 nodes; group the bottom and top ones (non-contiguous). */
function docWithGroup(): {
  doc: LogoDocument;
  grouped: LogoDocument;
  group: GroupNode;
} {
  const doc = createInitialDocument();
  const artboard = getActiveArtboard(doc);
  const [bottom, , top] = artboard.nodeIds;
  const group = createGroup([bottom!, top!]);

  const { document: grouped } = applyCommand(doc, {
    type: "group-nodes",
    containerId: artboard.id,
    group,
    index: 1,
  });

  return { doc, grouped, group };
}

describe("group-nodes / ungroup-nodes", () => {
  it("group-nodes pulls children out of the artboard order into the group", () => {
    const { doc, grouped, group } = docWithGroup();
    const before = getActiveArtboard(doc).nodeIds;
    const after = getActiveArtboard(grouped).nodeIds;

    expect(after).toEqual([before[1], group.id]);
    expect((grouped.nodes[group.id] as GroupNode).children).toEqual([
      before[0],
      before[2],
    ]);
  });

  it("group-nodes inverse restores exact non-contiguous stacking", () => {
    const { doc, group } = docWithGroup();
    const artboard = getActiveArtboard(doc);

    const { document: grouped, inverse } = applyCommand(doc, {
      type: "group-nodes",
      containerId: artboard.id,
      group,
      index: 1,
    });
    const { document: reverted } = applyCommand(grouped, inverse);

    expect(getActiveArtboard(reverted).nodeIds).toEqual(artboard.nodeIds);
    expect(reverted.nodes[group.id]).toBeUndefined();
  });

  it("ungroup-nodes splices children in place and inverse restores the group", () => {
    const { grouped, group } = docWithGroup();

    const { document: flat, inverse } = applyCommand(grouped, {
      type: "ungroup-nodes",
      groupId: group.id,
    });

    const flatIds = getActiveArtboard(flat).nodeIds;
    expect(flat.nodes[group.id]).toBeUndefined();
    expect(flatIds).toHaveLength(3);
    expect(flatIds.slice(1)).toEqual(group.children);

    const { document: regrouped } = applyCommand(flat, inverse);
    expect(getActiveArtboard(regrouped).nodeIds).toEqual(
      getActiveArtboard(grouped).nodeIds,
    );
    expect((regrouped.nodes[group.id] as GroupNode).children).toEqual(
      group.children,
    );
  });

  it("supports nesting a group inside a group", () => {
    const { grouped, group } = docWithGroup();
    const artboard = getActiveArtboard(grouped);
    const outer = createGroup([...artboard.nodeIds]);

    const { document: nested, inverse } = applyCommand(grouped, {
      type: "group-nodes",
      containerId: artboard.id,
      group: outer,
      index: 0,
    });

    expect(getActiveArtboard(nested).nodeIds).toEqual([outer.id]);
    expect(findContainerId(nested, group.id)).toBe(outer.id);
    expect(collectLeafNodeIds(nested, [outer.id])).toHaveLength(3);

    const { document: reverted } = applyCommand(nested, inverse);
    expect(getActiveArtboard(reverted).nodeIds).toEqual(artboard.nodeIds);
  });
});

describe("group-aware delete/restore/insert/reorder", () => {
  it("deleting a group removes the whole subtree and inverse restores it", () => {
    const { grouped, group } = docWithGroup();

    const { document: next, inverse } = applyCommand(grouped, {
      type: "delete-nodes",
      nodeIds: [group.id],
    });

    expect(next.nodes[group.id]).toBeUndefined();
    for (const childId of group.children) {
      expect(next.nodes[childId]).toBeUndefined();
    }

    const { document: restored } = applyCommand(next, inverse);
    expect(getActiveArtboard(restored).nodeIds).toEqual(
      getActiveArtboard(grouped).nodeIds,
    );
    expect((restored.nodes[group.id] as GroupNode).children).toEqual(
      group.children,
    );
    for (const childId of group.children) {
      expect(restored.nodes[childId]).toBeDefined();
    }
  });

  it("deleting a child inside a group updates children and inverse restores it", () => {
    const { grouped, group } = docWithGroup();
    const victim = group.children[0]!;

    const { document: next, inverse } = applyCommand(grouped, {
      type: "delete-nodes",
      nodeIds: [victim],
    });

    expect(next.nodes[victim]).toBeUndefined();
    expect((next.nodes[group.id] as GroupNode).children).toEqual([
      group.children[1],
    ]);

    const { document: restored } = applyCommand(next, inverse);
    expect((restored.nodes[group.id] as GroupNode).children).toEqual(
      group.children,
    );
  });

  it("insert-nodes with a subtree splices only the root into the artboard", () => {
    const doc = createInitialDocument();
    const artboard = getActiveArtboard(doc);
    const a = createRectangle({ x: 0, y: 0 });
    const b = createEllipse({ x: 50, y: 50 });
    const group = createGroup([a.id, b.id]);

    const { document: next, inverse } = applyCommand(doc, {
      type: "insert-nodes",
      artboardId: artboard.id,
      nodes: [a, b, group],
    });

    const ids = getActiveArtboard(next).nodeIds;
    expect(ids).toContain(group.id);
    expect(ids).not.toContain(a.id);
    expect(next.nodes[a.id]).toBeDefined();

    const { document: reverted } = applyCommand(next, inverse);
    expect(reverted.nodes[a.id]).toBeUndefined();
    expect(reverted.nodes[group.id]).toBeUndefined();
    expect(getActiveArtboard(reverted).nodeIds).toEqual(artboard.nodeIds);
  });

  it("insert-nodes can target a group container", () => {
    const { grouped, group } = docWithGroup();
    const extra = createRectangle({ x: 5, y: 5 });

    const { document: next } = applyCommand(grouped, {
      type: "insert-nodes",
      artboardId: grouped.activeArtboardId,
      containerId: group.id,
      nodes: [extra],
      index: 1,
    });

    expect((next.nodes[group.id] as GroupNode).children).toEqual([
      group.children[0],
      extra.id,
      group.children[1],
    ]);
    expect(getActiveArtboard(next).nodeIds).not.toContain(extra.id);
  });

  it("reorder-node works inside a group container", () => {
    const { grouped, group } = docWithGroup();

    const { document: next, inverse } = applyCommand(grouped, {
      type: "reorder-node",
      containerId: group.id,
      nodeId: group.children[0]!,
      toIndex: 1,
    });

    expect((next.nodes[group.id] as GroupNode).children).toEqual([
      group.children[1],
      group.children[0],
    ]);

    const { document: reverted } = applyCommand(next, inverse);
    expect((reverted.nodes[group.id] as GroupNode).children).toEqual(
      group.children,
    );
  });
});

describe("group queries", () => {
  it("unitBounds derives group bounds from children", () => {
    const { grouped, group } = docWithGroup();
    const [a, b] = group.children.map((id) => grouped.nodes[id]!);

    const bounds = unitBounds(grouped, group.id)!;
    expect(bounds.x).toBe(Math.min(a!.x, b!.x));
    expect(bounds.y).toBe(Math.min(a!.y, b!.y));
    expect(bounds.x + bounds.width).toBe(
      Math.max(a!.x + a!.width, b!.x + b!.width),
    );
  });

  it("getRenderNodesForArtboard flattens groups and cascades opacity/lock", () => {
    const { grouped, group } = docWithGroup();
    const { document: dimmed } = applyCommand(grouped, {
      type: "update-nodes",
      updates: [{ nodeId: group.id, patch: { opacity: 0.5, locked: true } }],
    });

    const leaves = getRenderNodesForArtboard(dimmed);
    expect(leaves).toHaveLength(3);
    expect(leaves.every((node) => node.type !== "group")).toBe(true);

    const child = leaves.find((node) => node.id === group.children[0])!;
    expect(child.opacity).toBeCloseTo(0.5 * grouped.nodes[child.id]!.opacity);
    expect(child.locked).toBe(true);
  });

  it("hidden groups drop their subtree from the render list", () => {
    const { grouped, group } = docWithGroup();
    const { document: hidden } = applyCommand(grouped, {
      type: "update-nodes",
      updates: [{ nodeId: group.id, patch: { visible: false } }],
    });

    const leaves = getRenderNodesForArtboard(hidden);
    expect(leaves).toHaveLength(1);
  });

  it("expandDeletionSet prunes groups emptied by the deletion", () => {
    const { grouped, group } = docWithGroup();

    const set = expandDeletionSet(grouped, group.children);
    expect(new Set(set)).toEqual(new Set([...group.children, group.id]));
  });
});

describe("schema v1 → v2 migration", () => {
  it("converts groupId tag clusters into a real GroupNode", () => {
    const doc = createInitialDocument();
    const artboard = getActiveArtboard(doc);
    const [bottom, , top] = artboard.nodeIds;
    const raw = JSON.parse(JSON.stringify(doc)) as {
      schemaVersion: number;
      nodes: Record<string, { groupId?: string }>;
    };
    raw.schemaVersion = 1;
    raw.nodes[bottom!]!.groupId = "group_legacy";
    raw.nodes[top!]!.groupId = "group_legacy";

    const migrated = parseDocument(raw);
    expect(migrated.schemaVersion).toBe(2);

    const ids = migrated.artboards[0]!.nodeIds;
    expect(ids).toHaveLength(2);
    const groupId = ids.find((id) => migrated.nodes[id]!.type === "group")!;
    expect((migrated.nodes[groupId] as GroupNode).children).toEqual([
      bottom,
      top,
    ]);

    for (const node of Object.values(migrated.nodes)) {
      expect((node as { groupId?: string }).groupId).toBeUndefined();
    }
  });

  it("parses v2 documents containing groups unchanged", () => {
    const { grouped } = docWithGroup();
    const parsed = parseDocument(JSON.parse(JSON.stringify(grouped)));
    expect(parsed).toEqual(grouped);
  });
});
