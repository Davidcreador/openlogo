import type { PathGeometry } from "./path-data";
import type { Artboard, LogoDocument, LogoNode } from "./types";

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
      groupId: string | undefined;
      cornerRadius: number;
      d: string;
      intrinsicWidth: number;
      intrinsicHeight: number;
      geometry: PathGeometry;
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
      nodes: LogoNode[];
      /** Insertion index in z-order; appends when omitted. */
      index?: number;
    }
  | {
      type: "delete-nodes";
      nodeIds: string[];
    }
  | {
      type: "restore-nodes";
      /** Inverse of delete-nodes: nodes plus their artboard/z positions. */
      entries: Array<{
        node: LogoNode;
        artboardId: string;
        index: number;
      }>;
    }
  | {
      type: "update-nodes";
      updates: Array<{ nodeId: string; patch: NodePatch }>;
    }
  | {
      type: "reorder-node";
      artboardId: string;
      nodeId: string;
      toIndex: number;
    }
  | {
      type: "add-artboard";
      artboard: Artboard;
      nodes: LogoNode[];
    }
  | {
      type: "remove-artboard";
      artboardId: string;
    }
  | {
      type: "update-artboard";
      artboardId: string;
      patch: ArtboardPatch;
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

      const insertedIds = command.nodes.map((node) => node.id);
      const artboards = document.artboards.map((artboard) => {
        if (artboard.id !== command.artboardId) {
          return artboard;
        }
        const nodeIds = [...artboard.nodeIds];
        nodeIds.splice(command.index ?? nodeIds.length, 0, ...insertedIds);
        return { ...artboard, nodeIds };
      });

      return {
        document: { ...document, nodes, artboards },
        inverse: { type: "delete-nodes", nodeIds: insertedIds },
      };
    }

    case "delete-nodes": {
      const removed = new Set(command.nodeIds);
      const entries: Array<{
        node: LogoNode;
        artboardId: string;
        index: number;
      }> = [];

      for (const artboard of document.artboards) {
        artboard.nodeIds.forEach((nodeId, index) => {
          const node = document.nodes[nodeId];
          if (node && removed.has(nodeId)) {
            entries.push({ node, artboardId: artboard.id, index });
          }
        });
      }

      const nodes = { ...document.nodes };
      for (const nodeId of command.nodeIds) {
        delete nodes[nodeId];
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

      // Restore in ascending index order so splice targets stay valid.
      const byArtboard = new Map<
        string,
        Array<{ node: LogoNode; index: number }>
      >();
      for (const entry of command.entries) {
        const list = byArtboard.get(entry.artboardId) ?? [];
        list.push({ node: entry.node, index: entry.index });
        byArtboard.set(entry.artboardId, list);
      }

      const artboards = document.artboards.map((artboard) => {
        const list = byArtboard.get(artboard.id);
        if (!list) {
          return artboard;
        }
        const nodeIds = [...artboard.nodeIds];
        for (const item of [...list].sort((a, b) => a.index - b.index)) {
          nodeIds.splice(Math.min(item.index, nodeIds.length), 0, item.node.id);
        }
        return { ...artboard, nodeIds };
      });

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
      const artboards = document.artboards.map((artboard) => {
        if (artboard.id !== command.artboardId) {
          return artboard;
        }
        const nodeIds = artboard.nodeIds.filter((id) => id !== command.nodeId);
        nodeIds.splice(
          Math.min(command.toIndex, nodeIds.length),
          0,
          command.nodeId,
        );
        return { ...artboard, nodeIds };
      });

      const fromIndex =
        document.artboards
          .find((artboard) => artboard.id === command.artboardId)
          ?.nodeIds.indexOf(command.nodeId) ?? 0;

      return {
        document: { ...document, artboards },
        inverse: { ...command, toIndex: fromIndex },
      };
    }

    case "add-artboard": {
      const nodes = { ...document.nodes };
      for (const node of command.nodes) {
        nodes[node.id] = node;
      }

      return {
        document: {
          ...document,
          nodes,
          artboards: [...document.artboards, command.artboard],
          activeArtboardId: command.artboard.id,
        },
        inverse: { type: "remove-artboard", artboardId: command.artboard.id },
      };
    }

    case "remove-artboard": {
      const artboard = document.artboards.find(
        (item) => item.id === command.artboardId,
      );

      if (!artboard || document.artboards.length <= 1) {
        return { document, inverse: command };
      }

      const nodes = { ...document.nodes };
      const removedNodes: LogoNode[] = [];
      for (const nodeId of artboard.nodeIds) {
        const node = nodes[nodeId];
        if (node) {
          removedNodes.push(node);
          delete nodes[nodeId];
        }
      }

      const artboards = document.artboards.filter(
        (item) => item.id !== command.artboardId,
      );
      const activeArtboardId =
        document.activeArtboardId === command.artboardId
          ? (artboards[0]?.id ?? document.activeArtboardId)
          : document.activeArtboardId;

      return {
        document: { ...document, nodes, artboards, activeArtboardId },
        inverse: { type: "add-artboard", artboard, nodes: removedNodes },
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
