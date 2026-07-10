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
import {
  DOCUMENT_SCHEMA_VERSION,
  type GroupNode,
  type LogoDocument,
} from "./types";

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

  it("restores an empty nested group after undoing ungroup", () => {
    const document = createInitialDocument();
    const artboard = getActiveArtboard(document);
    const empty = createGroup([]);
    const parent = createGroup([...artboard.nodeIds, empty.id]);
    document.nodes = {
      ...document.nodes,
      [empty.id]: empty,
      [parent.id]: parent,
    };
    document.artboards[0] = { ...artboard, nodeIds: [parent.id] };

    const command = { type: "ungroup-nodes", groupId: empty.id } as const;
    const { document: flat, inverse } = applyCommand(document, command);
    expect(flat.nodes[empty.id]).toBeUndefined();
    expect((flat.nodes[parent.id] as GroupNode).children).toEqual(
      artboard.nodeIds,
    );

    const { document: restored } = applyCommand(flat, inverse);
    expect(restored).toEqual(document);
    expect(applyCommand(restored, command).document).toEqual(flat);
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

describe("move-node", () => {
  it("moves a top-level node into a group at the given index", () => {
    const { grouped, group } = docWithGroup();
    const loose = getActiveArtboard(grouped).nodeIds.find(
      (id) => id !== group.id,
    )!;

    const { document: next, inverse } = applyCommand(grouped, {
      type: "move-node",
      nodeId: loose,
      toContainerId: group.id,
      toIndex: 1,
    });

    expect(getActiveArtboard(next).nodeIds).toEqual([group.id]);
    expect((next.nodes[group.id] as GroupNode).children).toEqual([
      group.children[0],
      loose,
      group.children[1],
    ]);
    expect(findContainerId(next, loose)).toBe(group.id);

    const { document: reverted } = applyCommand(next, inverse);
    expect(getActiveArtboard(reverted).nodeIds).toEqual(
      getActiveArtboard(grouped).nodeIds,
    );
    expect((reverted.nodes[group.id] as GroupNode).children).toEqual(
      group.children,
    );
  });

  it("moves a group child out to the artboard and inverse restores it", () => {
    const { grouped, group } = docWithGroup();
    const child = group.children[0]!;

    const { document: next, inverse } = applyCommand(grouped, {
      type: "move-node",
      nodeId: child,
      toContainerId: grouped.activeArtboardId,
      toIndex: 0,
    });

    expect(getActiveArtboard(next).nodeIds[0]).toBe(child);
    expect((next.nodes[group.id] as GroupNode).children).toEqual([
      group.children[1],
    ]);
    expect(findContainerId(next, child)).toBe(grouped.activeArtboardId);

    const { document: reverted } = applyCommand(next, inverse);
    expect(getActiveArtboard(reverted).nodeIds).toEqual(
      getActiveArtboard(grouped).nodeIds,
    );
    expect((reverted.nodes[group.id] as GroupNode).children).toEqual(
      group.children,
    );
  });

  it("moves a whole group subtree between containers intact", () => {
    const { grouped, group } = docWithGroup();
    const artboard = getActiveArtboard(grouped);
    const other = createGroup([artboard.nodeIds.find((id) => id !== group.id)!]);
    const { document: nested } = applyCommand(grouped, {
      type: "group-nodes",
      containerId: artboard.id,
      group: other,
      index: 0,
    });

    const { document: next, inverse } = applyCommand(nested, {
      type: "move-node",
      nodeId: group.id,
      toContainerId: other.id,
      toIndex: 0,
    });

    expect(getActiveArtboard(next).nodeIds).toEqual([other.id]);
    expect((next.nodes[other.id] as GroupNode).children[0]).toBe(group.id);
    // Subtree untouched.
    expect((next.nodes[group.id] as GroupNode).children).toEqual(
      group.children,
    );
    expect(collectLeafNodeIds(next, [other.id])).toHaveLength(3);

    const { document: reverted } = applyCommand(next, inverse);
    expect(getActiveArtboard(reverted).nodeIds).toEqual(
      getActiveArtboard(nested).nodeIds,
    );
  });

  it("same-container move acts as a reorder with an exact inverse", () => {
    const doc = createInitialDocument();
    const before = getActiveArtboard(doc).nodeIds;

    const { document: next, inverse } = applyCommand(doc, {
      type: "move-node",
      nodeId: before[0]!,
      toContainerId: doc.activeArtboardId,
      toIndex: 2,
    });

    expect(getActiveArtboard(next).nodeIds).toEqual([
      before[1],
      before[2],
      before[0],
    ]);

    const { document: reverted } = applyCommand(next, inverse);
    expect(getActiveArtboard(reverted).nodeIds).toEqual(before);
  });

  it("refuses to move a group into its own subtree", () => {
    const { grouped, group } = docWithGroup();
    const artboard = getActiveArtboard(grouped);
    const outer = createGroup([...artboard.nodeIds]);
    const { document: nested } = applyCommand(grouped, {
      type: "group-nodes",
      containerId: artboard.id,
      group: outer,
      index: 0,
    });

    const { document: next } = applyCommand(nested, {
      type: "move-node",
      nodeId: outer.id,
      toContainerId: group.id,
      toIndex: 0,
    });

    expect(next).toBe(nested);
  });

  it("is a no-op for a missing target container", () => {
    const doc = createInitialDocument();
    const { document: next } = applyCommand(doc, {
      type: "move-node",
      nodeId: getActiveArtboard(doc).nodeIds[0]!,
      toContainerId: "nope",
      toIndex: 0,
    });
    expect(next).toBe(doc);
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
    expect(migrated.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);

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
