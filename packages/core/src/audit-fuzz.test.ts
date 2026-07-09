import { describe, expect, it } from "vitest";
import type { Command, NodePatch } from "./commands";
import {
  createArtboard,
  createEllipse,
  createGroup,
  createInitialDocument,
  createRectangle,
} from "./factory";
import { expandDeletionSet } from "./queries";
import { DocumentStore } from "./store";
import type { GroupNode, LogoDocument } from "./types";

/**
 * AUDIT: random command fuzzing of undo/redo integrity.
 *
 * Applies N random commands through the DocumentStore, undoes all of
 * them, and deep-compares the result with the initial document; then
 * redoes all of them and compares with the final document. Comparison
 * is structural: object keys sorted, `undefined` values dropped (a
 * patch of `{stroke: undefined}` and an absent key are the same
 * document), so record insertion order never matters.
 */

/* ---------------- deterministic PRNG ---------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const pick = <T,>(rng: Rng, list: readonly T[]): T =>
  list[Math.floor(rng() * list.length)]!;
const int = (rng: Rng, max: number): number => Math.floor(rng() * max);

/* ---------------- structural normalization ---------------- */

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) {
        out[key] = normalize(item);
      }
    }
    return out;
  }
  return value;
}

const fingerprint = (doc: LogoDocument): string =>
  JSON.stringify(normalize(doc));

/* ---------------- integrity invariants ---------------- */

/** Referential integrity that must hold after ANY editor-shaped command. */
function checkIntegrity(doc: LogoDocument, context: string): string[] {
  const problems: string[] = [];
  const parentCount = new Map<string, number>();

  for (const artboard of doc.artboards) {
    for (const id of artboard.nodeIds) {
      if (!doc.nodes[id]) {
        problems.push(`${context}: artboard ${artboard.id} references missing node ${id}`);
      }
      parentCount.set(id, (parentCount.get(id) ?? 0) + 1);
    }
  }
  for (const node of Object.values(doc.nodes)) {
    if (node.type === "group") {
      for (const id of node.children) {
        if (!doc.nodes[id]) {
          problems.push(`${context}: group ${node.id} references missing child ${id}`);
        }
        parentCount.set(id, (parentCount.get(id) ?? 0) + 1);
      }
    }
  }
  for (const [id, count] of parentCount) {
    if (count > 1) {
      problems.push(`${context}: node ${id} has ${count} containers`);
    }
  }
  for (const id of Object.keys(doc.nodes)) {
    if (!parentCount.has(id)) {
      problems.push(`${context}: node ${id} is orphaned (no container references it)`);
    }
  }
  return problems;
}

/* ---------------- random command generation ---------------- */

function randomNodeId(rng: Rng, doc: LogoDocument): string | null {
  const ids = Object.keys(doc.nodes);
  return ids.length > 0 ? pick(rng, ids) : null;
}

function containerIds(doc: LogoDocument): string[] {
  return [
    ...doc.artboards.map((a) => a.id),
    ...Object.values(doc.nodes)
      .filter((n): n is GroupNode => n.type === "group")
      .map((n) => n.id),
  ];
}

function containerChildren(doc: LogoDocument, containerId: string): readonly string[] {
  const artboard = doc.artboards.find((a) => a.id === containerId);
  if (artboard) return artboard.nodeIds;
  const node = doc.nodes[containerId];
  return node?.type === "group" ? node.children : [];
}

function randomPatch(rng: Rng): NodePatch {
  const patches: NodePatch[] = [
    { x: Math.round(rng() * 600) },
    { y: Math.round(rng() * 400) },
    { width: 1 + Math.round(rng() * 300) },
    { height: 1 + Math.round(rng() * 300) },
    { rotation: Math.round(rng() * 720 - 360) },
    { opacity: Math.round(rng() * 100) / 100 },
    { visible: rng() > 0.3 },
    { locked: rng() > 0.7 },
    { name: `n${int(rng, 1000)}` },
    { fill: { type: "solid", color: "#123456" } },
    { stroke: { color: "#ff0000", width: rng() * 8, align: "center" } },
    { stroke: undefined },
  ];
  return pick(rng, patches);
}

/** One random editor-shaped command, or null when none applies. */
function randomCommand(
  rng: Rng,
  doc: LogoDocument,
  opts: { artboardOps: boolean; depth?: number },
): Command | null {
  const kinds = [
    "insert",
    "insert",
    "delete",
    "delete",
    "update",
    "update",
    "reorder",
    "move",
    "move",
    "group",
    "group",
    "ungroup",
    "ungroup",
    "batch",
    ...(opts.artboardOps
      ? ["add-artboard", "remove-artboard", "set-active", "update-artboard", "palette"]
      : []),
  ];

  switch (pick(rng, kinds)) {
    case "insert": {
      const artboard = pick(rng, doc.artboards);
      const node =
        rng() > 0.5
          ? createRectangle({ x: int(rng, 500), y: int(rng, 300) })
          : createEllipse({ x: int(rng, 500), y: int(rng, 300) });
      const groups = Object.values(doc.nodes).filter(
        (n): n is GroupNode => n.type === "group",
      );
      const container = rng() > 0.7 && groups.length > 0 ? pick(rng, groups).id : undefined;
      return {
        type: "insert-nodes",
        artboardId: artboard.id,
        nodes: [node],
        index: int(rng, 5),
        ...(container ? { containerId: container } : {}),
      };
    }
    case "delete": {
      const id = randomNodeId(rng, doc);
      if (!id) return null;
      // Editor path: expand to subtree + emptied ancestors first.
      return { type: "delete-nodes", nodeIds: expandDeletionSet(doc, [id]) };
    }
    case "update": {
      const id = randomNodeId(rng, doc);
      if (!id) return null;
      return { type: "update-nodes", updates: [{ nodeId: id, patch: randomPatch(rng) }] };
    }
    case "reorder": {
      const containers = containerIds(doc).filter(
        (c) => containerChildren(doc, c).length > 1,
      );
      if (containers.length === 0) return null;
      const containerId = pick(rng, containers);
      const children = containerChildren(doc, containerId);
      return {
        type: "reorder-node",
        containerId,
        nodeId: pick(rng, children),
        toIndex: int(rng, children.length + 1),
      };
    }
    case "move": {
      const id = randomNodeId(rng, doc);
      if (!id) return null;
      const target = pick(rng, containerIds(doc)); // may be own subtree: probes the guard
      return {
        type: "move-node",
        nodeId: id,
        toContainerId: target,
        toIndex: int(rng, containerChildren(doc, target).length + 1),
      };
    }
    case "group": {
      const containers = containerIds(doc).filter(
        (c) => containerChildren(doc, c).length >= 2,
      );
      if (containers.length === 0) return null;
      const containerId = pick(rng, containers);
      const children = [...containerChildren(doc, containerId)];
      const count = 2 + int(rng, children.length - 1);
      const members: string[] = [];
      while (members.length < count && children.length > 0) {
        members.push(children.splice(int(rng, children.length), 1)[0]!);
      }
      return {
        type: "group-nodes",
        containerId,
        group: createGroup(members),
        index: int(rng, containerChildren(doc, containerId).length),
      };
    }
    case "ungroup": {
      const groups = Object.values(doc.nodes).filter(
        (n): n is GroupNode => n.type === "group",
      );
      if (groups.length === 0) return null;
      return { type: "ungroup-nodes", groupId: pick(rng, groups).id };
    }
    case "batch": {
      if ((opts.depth ?? 0) > 0) return null;
      const commands: Command[] = [];
      let preview = doc;
      for (let i = 0; i < 2 + int(rng, 2); i += 1) {
        const child = randomCommand(rng, preview, { ...opts, depth: 1 });
        if (child && child.type !== "batch") {
          commands.push(child);
          // Keep generating against the mid-batch document so later
          // children stay editor-shaped.
          // eslint-disable-next-line @typescript-eslint/no-use-before-define
          preview = applyForPreview(preview, child);
        }
      }
      return commands.length > 0 ? { type: "batch", commands } : null;
    }
    case "add-artboard": {
      const node = createRectangle({ x: 10, y: 10 });
      const artboard = createArtboard("icon", { nodeIds: [node.id] });
      return { type: "add-artboard", artboard, nodes: [node] };
    }
    case "remove-artboard": {
      if (doc.artboards.length < 2) return null;
      return { type: "remove-artboard", artboardId: pick(rng, doc.artboards).id };
    }
    case "set-active":
      return { type: "set-active-artboard", artboardId: pick(rng, doc.artboards).id };
    case "update-artboard":
      return {
        type: "update-artboard",
        artboardId: pick(rng, doc.artboards).id,
        patch: { name: `board${int(rng, 100)}`, background: "#ffffff" },
      };
    case "palette": {
      const palette = doc.palettes[0];
      if (!palette) return null;
      return {
        type: "update-palette",
        paletteId: palette.id,
        colors: ["#000000", `#${int(rng, 0xffffff).toString(16).padStart(6, "0")}`],
      };
    }
  }
  return null;
}

import { applyCommand } from "./commands";
function applyForPreview(doc: LogoDocument, command: Command): LogoDocument {
  return applyCommand(doc, command).document;
}

/* ---------------- the fuzz harness ---------------- */

function runFuzz(seed: number, steps: number, artboardOps: boolean) {
  const rng = mulberry32(seed);
  const store = new DocumentStore(createInitialDocument());
  const applied: Command[] = [];
  const integrityProblems: string[] = [];
  const mismatches: string[] = [];
  // snapshots[i] = fingerprint after `i` applied commands.
  const snapshots: string[] = [fingerprint(store.document)];

  for (let i = 0; i < steps; i += 1) {
    const command = randomCommand(rng, store.document, { artboardOps });
    if (!command) continue;
    store.apply(command);
    applied.push(command);
    snapshots.push(fingerprint(store.document));
    integrityProblems.push(
      ...checkIntegrity(store.document, `seed=${seed} step=${i} ${command.type}`),
    );
  }

  // Undo step by step: after undoing command i, the document must equal
  // the snapshot taken right before command i was applied.
  for (let i = applied.length - 1; i >= 0; i -= 1) {
    store.undo();
    if (fingerprint(store.document) !== snapshots[i]) {
      mismatches.push(
        `seed=${seed}: undo of #${i} (${applied[i]!.type}) did not restore prior state`,
      );
    }
  }
  // Redo step by step against the same snapshots.
  for (let i = 0; i < applied.length; i += 1) {
    store.redo();
    if (fingerprint(store.document) !== snapshots[i + 1]) {
      mismatches.push(
        `seed=${seed}: redo of #${i} (${applied[i]!.type}) did not reproduce state`,
      );
    }
  }

  return { applied, integrityProblems, mismatches };
}

const dump = (commands: Command[]): string =>
  JSON.stringify(commands).slice(0, 4000);

describe("AUDIT fuzz: undo/redo round-trip", () => {
  it("node ops: every undo/redo step restores the exact snapshot (60 seeds x 40 ops)", () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const r = runFuzz(seed, 40, false);
      expect(r.integrityProblems, dump(r.applied)).toEqual([]);
      expect(r.mismatches, dump(r.applied)).toEqual([]);
    }
  });

  it("all ops incl. artboards: every undo/redo step restores the exact snapshot (40 seeds x 30 ops)", () => {
    for (let seed = 1000; seed < 1040; seed += 1) {
      const r = runFuzz(seed, 30, true);
      expect(r.integrityProblems, dump(r.applied)).toEqual([]);
      expect(r.mismatches, dump(r.applied)).toEqual([]);
    }
  });
});
