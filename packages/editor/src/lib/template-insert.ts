import {
  type Command,
  type Effect,
  type LogoDocument,
  type LogoNode,
  createGroup,
  createId,
  getActiveArtboard,
} from "@openlogo/core";
import { documentStore } from "../state/document";

export type TemplateInsert = {
  command: Extract<Command, { type: "insert-nodes" }>;
  groupId: string;
};

function scaleEffect(effect: Effect, scale: number): Effect {
  switch (effect.type) {
    case "drop-shadow":
      return {
        ...effect,
        dx: effect.dx * scale,
        dy: effect.dy * scale,
        blur: effect.blur * scale,
      };
    case "outline":
      return { ...effect, width: effect.width * scale };
    case "bevel":
      return {
        ...effect,
        size: effect.size * scale,
        soften: effect.soften * scale,
      };
    case "glow":
      return { ...effect, blur: effect.blur * scale };
  }
}

function materializeNode(
  node: LogoNode,
  ids: ReadonlyMap<string, string>,
  scale: number,
  offsetX: number,
  offsetY: number,
): LogoNode {
  const clone = structuredClone(node);
  clone.id = ids.get(node.id)!;
  clone.x = offsetX + node.x * scale;
  clone.y = offsetY + node.y * scale;
  clone.width = node.width * scale;
  clone.height = node.height * scale;
  if (clone.stroke) {
    clone.stroke.width *= scale;
  }
  if (clone.effects) {
    clone.effects = clone.effects.map((effect) => scaleEffect(effect, scale));
  }
  if (clone.type === "group" && node.type === "group") {
    clone.children = node.children.map((id) => ids.get(id)!);
    if (node.clippingMaskId) {
      clone.clippingMaskId = ids.get(node.clippingMaskId)!;
    }
  }
  if (clone.type === "text" && node.type === "text") {
    clone.fontSize = node.fontSize * scale;
    clone.letterSpacing = node.letterSpacing * scale;
    if (clone.onPath) {
      clone.onPath.pathId = ids.get(node.onPath!.pathId)!;
      clone.onPath.startOffset = node.onPath!.startOffset * scale;
    }
  }
  return clone;
}

/** Materialize a proposal as one grouped subtree, ready for one history entry. */
export function createTemplateInsert(
  target: LogoDocument,
  proposal: LogoDocument,
  label: string,
): TemplateInsert | null {
  const targetArtboard = getActiveArtboard(target);
  const sourceArtboard = getActiveArtboard(proposal);
  if (!targetArtboard || !sourceArtboard || sourceArtboard.nodeIds.length === 0) {
    return null;
  }

  const scale = Math.min(
    (targetArtboard.width * 0.76) / sourceArtboard.width,
    (targetArtboard.height * 0.76) / sourceArtboard.height,
  );
  const offsetX = (targetArtboard.width - sourceArtboard.width * scale) / 2;
  const offsetY = (targetArtboard.height - sourceArtboard.height * scale) / 2;
  const ids = new Map(
    Object.values(proposal.nodes).map((node) => [
      node.id,
      createId(node.type === "group" ? "group" : "node"),
    ]),
  );
  const nodes = Object.values(proposal.nodes).map((node) =>
    materializeNode(node, ids, scale, offsetX, offsetY),
  );
  const rootChildren = sourceArtboard.nodeIds.map((id) => ids.get(id)!);
  const group = {
    ...createGroup(rootChildren, {
      x: offsetX,
      y: offsetY,
      width: sourceArtboard.width * scale,
      height: sourceArtboard.height * scale,
    }),
    name: `Template · ${label}`,
  };

  return {
    command: {
      type: "insert-nodes",
      artboardId: targetArtboard.id,
      nodes: [...nodes, group],
    },
    groupId: group.id,
  };
}

export function insertTemplateDocument(
  proposal: LogoDocument,
  label: string,
): string | null {
  const insertion = createTemplateInsert(documentStore.document, proposal, label);
  if (!insertion) {
    return null;
  }
  documentStore.apply(insertion.command);
  return documentStore.document.nodes[insertion.groupId]
    ? insertion.groupId
    : null;
}
