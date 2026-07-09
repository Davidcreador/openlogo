import type { PathGeometry } from "./path-data";
import { collectSubtreeIds, findContainerId } from "./queries";
import type {
  Artboard,
  GroupNode,
  LogoDocument,
  LogoNode,
  ShapeParams,
} from "./types";

/**
 * Every document mutation is a serializable command. `applyCommand` returns
 * the next document plus the exact inverse command, which is what the
 * history stack stores — no full-document snapshots.
 *
 * Commands being plain data keeps the door open for multiplayer later:
 * they can be shipped over the wire and rebased without changing the model.
 */

/** Patch over any node field except identity. */
export type NodePatch = Partial<
  Omit<
    {
      name: string;
      x: number;
      y: number;
      width: number;
      height: number;
      rotation: number;
      opacity: number;
      visible: boolean;
      locked: boolean;
      fill: LogoNode["fill"];
      stroke: LogoNode["stroke"];
      blendMode: LogoNode["blendMode"];
      cornerRadius: number;
      d: string;
      intrinsicWidth: number;
      intrinsicHeight: number;
      geometry: PathGeometry;
      /** undefined detaches a shape node from its params (bezier edit). */
      shape: ShapeParams | undefined;
      content: string;
      fontFamily: string;
      fontSize: number;
      fontWeight: number;
      letterSpacing: number;
      lineHeight: number;
      align: "left" | "center" | "right";
    },
    never
  >
>;

export type ArtboardPatch = Partial<Omit<Artboard, "id" | "nodeIds">>;

export type Command =
  | {
      type: "insert-nodes";
      artboardId: string;
      /**
       * Nodes to add. May contain whole subtrees: any node referenced as
       * a child of an inserted group is added to the node table only —
       * just the roots are spliced into the container's ordering.
       */
      nodes: LogoNode[];
      /** Insertion index in z-order; appends when omitted. */
      index?: number;
      /** Group to insert into; the artboard's top level when omitted. */
      containerId?: string;
    }
  | {
      type: "delete-nodes";
      /** Deleting a group deletes its whole subtree. */
      nodeIds: string[];
    }
  | {
      type: "restore-nodes";
      /**
       * Inverse of delete-nodes: nodes plus their container (artboard id
       * or group id) and index within that container's ordering.
       */
      entries: Array<{
        node: LogoNode;
        containerId: string;
        index: number;
      }>;
    }
  | {
      type: "update-nodes";
      updates: Array<{ nodeId: string; patch: NodePatch }>;
    }
  | {
      type: "reorder-node";
      /** Artboard id (top level) or group id. */
      containerId: string;
      nodeId: string;
      toIndex: number;
    }
  | {
      type: "move-node";
      /**
       * Reparent a node (subtree rides along) to another container —
       * artboard id or group id — at `toIndex` in its ordering. No-op
       * when the target is missing or inside the node's own subtree.
       */
      nodeId: string;
      toContainerId: string;
      toIndex: number;
    }
  | {
      type: "group-nodes";
      /** Artboard id (top level) or parent group id holding the children. */
      containerId: string;
      /** The group node; `children` must already live in the container. */
      group: GroupNode;
      /** Index the group takes in the container after children are pulled. */
      index: number;
    }
  | {
      type: "ungroup-nodes";
      groupId: string;
      /**
       * Original container indices of the children, ascending pair-wise
       * with `children` order — set by group-nodes' inverse so undoing a
       * group restores non-contiguous stacking exactly. When omitted the
       * children splice in contiguously at the group's position.
       */
      restoreIndices?: number[];
    }
  | {
      type: "add-artboard";
      artboard: Artboard;
      nodes: LogoNode[];
      /** Position in the artboard list; appends when omitted. */
      index?: number;
      /** Set false to keep the current active artboard (undo of remove). */
      activate?: boolean;
    }
  | {
      type: "remove-artboard";
      artboardId: string;
      /**
       * Active artboard to fall back to when the removed one was active
       * (set by add-artboard's inverse so undo restores it exactly).
       */
      restoreActiveArtboardId?: string;
    }
  | {
      type: "update-artboard";
      artboardId: string;
      patch: ArtboardPatch;
    }
  | {
      type: "reorder-artboard";
      artboardId: string;
      /** Position in the artboard list after removal-then-splice. */
      toIndex: number;
    }
  | {
      type: "set-active-artboard";
      artboardId: string;
    }
  | {
      type: "rename-document";
      name: string;
    }
  | {
      type: "update-palette";
      paletteId: string;
      colors: string[];
    }
  | {
      type: "batch";
      /** Applied in order; undone as one history entry. */
      commands: Command[];
      /** Optional label for future history UI. */
      label?: string;
    };

export type ApplyResult = {
  document: LogoDocument;
  inverse: Command;
};

function pickInversePatch(node: LogoNode, patch: NodePatch): NodePatch {
  const inverse: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    inverse[key] = (node as unknown as Record<string, unknown>)[key];
  }
  return inverse as NodePatch;
}

function patchNode(node: LogoNode, patch: NodePatch): LogoNode {
  return { ...node, ...patch } as LogoNode;
}

/**
 * Replace a container's ordered child list. Containers are either an
 * artboard (top-level `nodeIds`) or a group node (`children`). Mutates
 * the passed `nodes` copy for group containers; returns the artboard
 * list to use.
 */
function withContainerList(
  artboards: Artboard[],
  nodes: Record<string, LogoNode>,
  containerId: string,
  list: string[],
): Artboard[] {
  const artboard = artboards.find((item) => item.id === containerId);
  if (artboard) {
    return artboards.map((item) =>
      item.id === containerId ? { ...item, nodeIds: list } : item,
    );
  }
  const container = nodes[containerId];
  if (container?.type === "group") {
    nodes[containerId] = { ...container, children: list };
  }
  return artboards;
}

/** Ordered child list of a container, or null when it doesn't exist. */
function containerListOf(
  document: LogoDocument,
  containerId: string,
): readonly string[] | null {
  const artboard = document.artboards.find((item) => item.id === containerId);
  if (artboard) {
    return artboard.nodeIds;
  }
  const node = document.nodes[containerId];
  return node?.type === "group" ? node.children : null;
}

export function applyCommand(
  document: LogoDocument,
  command: Command,
): ApplyResult {
  switch (command.type) {
    case "insert-nodes": {
      const nodes = { ...document.nodes };
      for (const node of command.nodes) {
        nodes[node.id] = node;
      }

      // Nodes referenced as children of an inserted group ride along in
      // the node table; only roots enter the container's ordering.
      const insertedChildIds = new Set<string>();
      for (const node of command.nodes) {
        if (node.type === "group") {
          for (const childId of node.children) {
            insertedChildIds.add(childId);
          }
        }
      }
      const rootIds = command.nodes
        .map((node) => node.id)
        .filter((id) => !insertedChildIds.has(id));

      const containerId =
        command.containerId && nodes[command.containerId]?.type === "group"
          ? command.containerId
          : command.artboardId;
      const list = [...(containerListOf(document, containerId) ?? [])];
      list.splice(command.index ?? list.length, 0, ...rootIds);
      const artboards = withContainerList(document.artboards, nodes, containerId, list);

      return {
        document: { ...document, nodes, artboards },
        inverse: { type: "delete-nodes", nodeIds: rootIds },
      };
    }

    case "delete-nodes": {
      // Deleting a group takes its whole subtree with it.
      const removed = new Set<string>();
      const visit = (id: string) => {
        const node = document.nodes[id];
        if (!node || removed.has(id)) {
          return;
        }
        removed.add(id);
        if (node.type === "group") {
          node.children.forEach(visit);
        }
      };
      command.nodeIds.forEach(visit);

      const entries: Array<{
        node: LogoNode;
        containerId: string;
        index: number;
      }> = [];

      for (const artboard of document.artboards) {
        artboard.nodeIds.forEach((nodeId, index) => {
          const node = document.nodes[nodeId];
          if (node && removed.has(nodeId)) {
            entries.push({ node, containerId: artboard.id, index });
          }
        });
      }
      for (const container of Object.values(document.nodes)) {
        if (container.type !== "group") {
          continue;
        }
        container.children.forEach((childId, index) => {
          const node = document.nodes[childId];
          if (node && removed.has(childId)) {
            entries.push({ node, containerId: container.id, index });
          }
        });
      }

      const nodes = { ...document.nodes };
      for (const nodeId of removed) {
        delete nodes[nodeId];
      }
      // Surviving groups drop any removed children.
      for (const [id, node] of Object.entries(nodes)) {
        if (
          node.type === "group" &&
          node.children.some((childId) => removed.has(childId))
        ) {
          nodes[id] = {
            ...node,
            children: node.children.filter((childId) => !removed.has(childId)),
          };
        }
      }

      const artboards = document.artboards.map((artboard) => ({
        ...artboard,
        nodeIds: artboard.nodeIds.filter((nodeId) => !removed.has(nodeId)),
      }));

      return {
        document: { ...document, nodes, artboards },
        inverse: { type: "restore-nodes", entries },
      };
    }

    case "restore-nodes": {
      const nodes = { ...document.nodes };
      for (const entry of command.entries) {
        nodes[entry.node.id] = entry.node;
      }

      const byContainer = new Map<string, Array<{ id: string; index: number }>>();
      for (const entry of command.entries) {
        const list = byContainer.get(entry.containerId) ?? [];
        list.push({ id: entry.node.id, index: entry.index });
        byContainer.set(entry.containerId, list);
      }

      // Ascending splice keeps indices valid. A restored group carries
      // its children list, so skip ids a container already holds.
      const spliceAll = (
        list: string[],
        items: Array<{ id: string; index: number }>,
      ) => {
        for (const item of [...items].sort((a, b) => a.index - b.index)) {
          if (!list.includes(item.id)) {
            list.splice(Math.min(item.index, list.length), 0, item.id);
          }
        }
        return list;
      };

      const artboards = document.artboards.map((artboard) => {
        const items = byContainer.get(artboard.id);
        return items
          ? { ...artboard, nodeIds: spliceAll([...artboard.nodeIds], items) }
          : artboard;
      });

      for (const [containerId, items] of byContainer) {
        const container = nodes[containerId];
        if (container?.type === "group") {
          nodes[containerId] = {
            ...container,
            children: spliceAll([...container.children], items),
          };
        }
      }

      return {
        document: { ...document, nodes, artboards },
        inverse: {
          type: "delete-nodes",
          nodeIds: command.entries.map((entry) => entry.node.id),
        },
      };
    }

    case "update-nodes": {
      const nodes = { ...document.nodes };
      const inverseUpdates: Array<{ nodeId: string; patch: NodePatch }> = [];

      for (const update of command.updates) {
        const node = nodes[update.nodeId];
        if (!node) {
          continue;
        }
        inverseUpdates.push({
          nodeId: update.nodeId,
          patch: pickInversePatch(node, update.patch),
        });
        nodes[update.nodeId] = patchNode(node, update.patch);
      }

      return {
        document: { ...document, nodes },
        inverse: { type: "update-nodes", updates: inverseUpdates },
      };
    }

    case "reorder-node": {
      const list = containerListOf(document, command.containerId);
      if (!list || !list.includes(command.nodeId)) {
        return { document, inverse: command };
      }

      const fromIndex = list.indexOf(command.nodeId);
      const next = list.filter((id) => id !== command.nodeId);
      next.splice(Math.min(command.toIndex, next.length), 0, command.nodeId);

      const nodes = { ...document.nodes };
      const artboards = withContainerList(
        document.artboards,
        nodes,
        command.containerId,
        next,
      );

      return {
        document: { ...document, nodes, artboards },
        inverse: { ...command, toIndex: fromIndex },
      };
    }

    case "move-node": {
      const node = document.nodes[command.nodeId];
      const fromContainerId = findContainerId(document, command.nodeId);
      const targetList = containerListOf(document, command.toContainerId);
      if (
        !node ||
        !fromContainerId ||
        !targetList ||
        // A node cannot move into its own subtree.
        collectSubtreeIds(document, command.nodeId).includes(
          command.toContainerId,
        )
      ) {
        return { document, inverse: command };
      }

      const fromList = containerListOf(document, fromContainerId)!;
      const fromIndex = fromList.indexOf(command.nodeId);

      const nodes = { ...document.nodes };
      let artboards = document.artboards;

      if (fromContainerId === command.toContainerId) {
        // Same container: remove-then-splice, like reorder-node.
        const next = fromList.filter((id) => id !== command.nodeId);
        next.splice(Math.min(command.toIndex, next.length), 0, command.nodeId);
        artboards = withContainerList(artboards, nodes, fromContainerId, next);
      } else {
        const sourceNext = fromList.filter((id) => id !== command.nodeId);
        artboards = withContainerList(
          artboards,
          nodes,
          fromContainerId,
          sourceNext,
        );
        const targetNext = [...targetList];
        targetNext.splice(
          Math.min(command.toIndex, targetNext.length),
          0,
          command.nodeId,
        );
        artboards = withContainerList(
          artboards,
          nodes,
          command.toContainerId,
          targetNext,
        );
      }

      return {
        document: { ...document, nodes, artboards },
        inverse: {
          type: "move-node",
          nodeId: command.nodeId,
          toContainerId: fromContainerId,
          toIndex: fromIndex,
        },
      };
    }

    case "group-nodes": {
      const { group } = command;
      const list = containerListOf(document, command.containerId);
      if (!list) {
        return { document, inverse: command };
      }

      // Pair-wise with group.children so the inverse can put each child
      // back at its exact pre-group container index.
      const restoreIndices = group.children.map((childId) =>
        list.indexOf(childId),
      );

      const childSet = new Set(group.children);
      const next = list.filter((id) => !childSet.has(id));
      next.splice(Math.min(command.index, next.length), 0, group.id);

      const nodes = { ...document.nodes, [group.id]: group };
      const artboards = withContainerList(
        document.artboards,
        nodes,
        command.containerId,
        next,
      );

      return {
        document: { ...document, nodes, artboards },
        inverse: { type: "ungroup-nodes", groupId: group.id, restoreIndices },
      };
    }

    case "ungroup-nodes": {
      const group = document.nodes[command.groupId];
      if (group?.type !== "group") {
        return { document, inverse: command };
      }

      const artboard = document.artboards.find((item) =>
        item.nodeIds.includes(group.id),
      );
      const parentGroup = artboard
        ? undefined
        : Object.values(document.nodes).find(
            (node): node is GroupNode =>
              node.type === "group" && node.children.includes(group.id),
          );
      const containerId = artboard?.id ?? parentGroup?.id;
      const list = containerId ? containerListOf(document, containerId) : null;
      if (!containerId || !list) {
        return { document, inverse: command };
      }

      const fromIndex = list.indexOf(group.id);
      const next = list.filter((id) => id !== group.id);

      if (
        command.restoreIndices &&
        command.restoreIndices.length === group.children.length
      ) {
        const pairs = group.children
          .map((id, i) => ({
            id,
            index:
              command.restoreIndices![i]! >= 0
                ? command.restoreIndices![i]!
                : next.length,
          }))
          .sort((a, b) => a.index - b.index);
        for (const pair of pairs) {
          next.splice(Math.min(pair.index, next.length), 0, pair.id);
        }
      } else {
        next.splice(fromIndex, 0, ...group.children);
      }

      const nodes = { ...document.nodes };
      delete nodes[group.id];
      const artboards = withContainerList(document.artboards, nodes, containerId, next);

      return {
        document: { ...document, nodes, artboards },
        inverse: { type: "group-nodes", containerId, group, index: fromIndex },
      };
    }

    case "add-artboard": {
      const nodes = { ...document.nodes };
      for (const node of command.nodes) {
        nodes[node.id] = node;
      }

      const artboards = [...document.artboards];
      artboards.splice(
        Math.min(command.index ?? artboards.length, artboards.length),
        0,
        command.artboard,
      );

      return {
        document: {
          ...document,
          nodes,
          artboards,
          activeArtboardId:
            command.activate === false
              ? document.activeArtboardId
              : command.artboard.id,
        },
        inverse: {
          type: "remove-artboard",
          artboardId: command.artboard.id,
          restoreActiveArtboardId: document.activeArtboardId,
        },
      };
    }

    case "remove-artboard": {
      const index = document.artboards.findIndex(
        (item) => item.id === command.artboardId,
      );
      const artboard = document.artboards[index];

      if (!artboard || document.artboards.length <= 1) {
        return { document, inverse: command };
      }

      // Removing an artboard takes every node on it, whole subtrees
      // included — otherwise grouped children linger as orphans.
      const nodes = { ...document.nodes };
      const removedNodes: LogoNode[] = [];
      for (const rootId of artboard.nodeIds) {
        for (const nodeId of collectSubtreeIds(document, rootId)) {
          const node = nodes[nodeId];
          if (node) {
            removedNodes.push(node);
            delete nodes[nodeId];
          }
        }
      }

      const artboards = document.artboards.filter(
        (item) => item.id !== command.artboardId,
      );
      const wasActive = document.activeArtboardId === command.artboardId;
      const restore = command.restoreActiveArtboardId;
      const activeArtboardId = wasActive
        ? restore && artboards.some((item) => item.id === restore)
          ? restore
          : (artboards[0]?.id ?? document.activeArtboardId)
        : document.activeArtboardId;

      return {
        document: { ...document, nodes, artboards, activeArtboardId },
        inverse: {
          type: "add-artboard",
          artboard,
          nodes: removedNodes,
          index,
          activate: wasActive,
        },
      };
    }

    case "update-artboard": {
      const previous = document.artboards.find(
        (item) => item.id === command.artboardId,
      );
      const inversePatch: Record<string, unknown> = {};

      if (previous) {
        for (const key of Object.keys(command.patch)) {
          inversePatch[key] = (previous as unknown as Record<string, unknown>)[
            key
          ];
        }
      }

      return {
        document: {
          ...document,
          artboards: document.artboards.map((item) =>
            item.id === command.artboardId ? { ...item, ...command.patch } : item,
          ),
        },
        inverse: {
          type: "update-artboard",
          artboardId: command.artboardId,
          patch: inversePatch as ArtboardPatch,
        },
      };
    }

    case "reorder-artboard": {
      const fromIndex = document.artboards.findIndex(
        (item) => item.id === command.artboardId,
      );
      if (fromIndex === -1) {
        return { document, inverse: command };
      }

      const artboards = document.artboards.filter(
        (item) => item.id !== command.artboardId,
      );
      artboards.splice(
        Math.min(command.toIndex, artboards.length),
        0,
        document.artboards[fromIndex]!,
      );

      return {
        document: { ...document, artboards },
        inverse: { ...command, toIndex: fromIndex },
      };
    }

    case "set-active-artboard": {
      return {
        document: { ...document, activeArtboardId: command.artboardId },
        inverse: {
          type: "set-active-artboard",
          artboardId: document.activeArtboardId,
        },
      };
    }

    case "rename-document": {
      return {
        document: { ...document, name: command.name },
        inverse: { type: "rename-document", name: document.name },
      };
    }

    case "update-palette": {
      const previous = document.palettes.find(
        (item) => item.id === command.paletteId,
      );
      return {
        document: {
          ...document,
          palettes: document.palettes.map((item) =>
            item.id === command.paletteId
              ? { ...item, colors: command.colors }
              : item,
          ),
        },
        inverse: {
          type: "update-palette",
          paletteId: command.paletteId,
          colors: previous?.colors ?? [],
        },
      };
    }

    case "batch": {
      let next = document;
      const inverses: Command[] = [];

      for (const child of command.commands) {
        const result = applyCommand(next, child);
        next = result.document;
        inverses.push(result.inverse);
      }

      return {
        document: next,
        inverse: {
          type: "batch",
          commands: inverses.reverse(),
          ...(command.label !== undefined ? { label: command.label } : {}),
        },
      };
    }
  }
}
