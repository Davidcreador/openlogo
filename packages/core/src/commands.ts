// The domain already owns the name `Effect` (layer effects), so the
// effect-ts modules come in under aliases here.
import * as Data from "effect/Data";
import * as Fx from "effect/Effect";
import type { PathGeometry } from "./path-data";
import { collectSubtreeIds, findContainerId } from "./queries";
import type {
  Artboard,
  Effect,
  GroupNode,
  LogoDocument,
  LogoNode,
  Paint,
  PathFillRule,
  ShapeParams,
  TextPathAttachment,
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
      fillRule: PathFillRule;
      geometry: PathGeometry;
      /** undefined detaches a shape node from its params (bezier edit). */
      shape: ShapeParams | undefined;
      /** undefined clears the node's effect stack. */
      effects: Effect[] | undefined;
      content: string;
      fontFamily: string;
      fontSize: number;
      fontWeight: number;
      /** undefined resets to upright. */
      fontStyle: "normal" | "italic" | undefined;
      letterSpacing: number;
      lineHeight: number;
      align: "left" | "center" | "right";
      /** undefined clears all manual kerning. */
      kerning: Record<number, number> | undefined;
      /** undefined resets OpenType features to font defaults. */
      otFeatures: Record<string, boolean> | undefined;
      /** undefined detaches the text from its path. */
      onPath: TextPathAttachment | undefined;
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
      /** Relationships cleared on surviving nodes while targets were deleted. */
      clippingMasks?: Array<{ groupId: string; maskId: string }>;
      textPaths?: Array<{
        textId: string;
        attachment: TextPathAttachment;
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

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export function sanitizePaint(paint: Paint): Paint {
  if (paint.type === "solid") {
    return { ...paint };
  }
  const stops = paint.stops
    .map((stop) => ({
      ...stop,
      offset: Number.isFinite(stop.offset) ? clamp(stop.offset, 0, 1) : 0,
      ...(stop.alpha !== undefined
        ? {
            alpha: Number.isFinite(stop.alpha)
              ? clamp(stop.alpha, 0, 1)
              : 1,
          }
        : {}),
    }))
    .sort((a, b) => a.offset - b.offset);
  if (paint.type === "linear-gradient") {
    const validPoint = (point: { x: number; y: number } | undefined) =>
      point && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? { ...point }
        : undefined;
    const start = validPoint(paint.start);
    const end = validPoint(paint.end);
    const { start: _start, end: _end, ...base } = paint;
    return {
      ...base,
      angle: Number.isFinite(paint.angle) ? paint.angle : 0,
      stops,
      ...(start && end ? { start, end } : {}),
    };
  }
  const { fx: _fx, fy: _fy, ...base } = paint;
  return {
    ...base,
    cx: Number.isFinite(paint.cx) ? paint.cx : 0.5,
    cy: Number.isFinite(paint.cy) ? paint.cy : 0.5,
    r: Number.isFinite(paint.r) ? Math.max(0, paint.r) : 0.5,
    ...(paint.fx !== undefined && Number.isFinite(paint.fx)
      ? { fx: paint.fx }
      : {}),
    ...(paint.fy !== undefined && Number.isFinite(paint.fy)
      ? { fy: paint.fy }
      : {}),
    stops,
  };
}

/**
 * Command and preview patches share one scalar/paint safety boundary. Invalid
 * coordinates are ignored; bounded values are clamped into the document
 * schema's domain.
 */
export function sanitizeNodePatch(node: LogoNode, patch: NodePatch): NodePatch {
  const safe = { ...patch };
  const removeKeys = (keys: readonly (keyof NodePatch)[]) => {
    for (const key of keys) {
      delete safe[key];
    }
  };
  const pathKeys = [
    "d",
    "intrinsicWidth",
    "intrinsicHeight",
    "fillRule",
    "geometry",
    "shape",
  ] as const;
  const textKeys = [
    "content",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "letterSpacing",
    "lineHeight",
    "align",
    "kerning",
    "otFeatures",
    "onPath",
  ] as const;
  if (node.type !== "path") {
    removeKeys(pathKeys);
  }
  if (node.type !== "text") {
    removeKeys(textKeys);
  }
  if (node.type !== "rectangle") {
    delete safe.cornerRadius;
  }
  const finiteKeys: Array<keyof NodePatch> = [
    "x",
    "y",
    "rotation",
    "letterSpacing",
  ];
  for (const key of finiteKeys) {
    const value = safe[key];
    if (key in safe && (typeof value !== "number" || !Number.isFinite(value))) {
      delete safe[key];
    }
  }
  for (const key of [
    "width",
    "height",
    "intrinsicWidth",
    "intrinsicHeight",
    "fontSize",
    "lineHeight",
  ] as const) {
    const value = safe[key];
    if (key in safe) {
      if (typeof value === "number" && Number.isFinite(value)) {
        safe[key] = Math.max(0.01, value);
      } else {
        delete safe[key];
      }
    }
  }
  if ("opacity" in safe) {
    if (typeof safe.opacity === "number" && Number.isFinite(safe.opacity)) {
      safe.opacity = clamp(safe.opacity, 0, 1);
    } else {
      delete safe.opacity;
    }
  }
  if ("cornerRadius" in safe) {
    if (
      typeof safe.cornerRadius === "number" &&
      Number.isFinite(safe.cornerRadius)
    ) {
      safe.cornerRadius = Math.max(0, safe.cornerRadius);
    } else {
      delete safe.cornerRadius;
    }
  }
  if ("fontWeight" in safe) {
    if (
      typeof safe.fontWeight === "number" &&
      Number.isFinite(safe.fontWeight)
    ) {
      safe.fontWeight = Math.max(1, safe.fontWeight);
    } else {
      delete safe.fontWeight;
    }
  }
  if ("fill" in safe) {
    if (safe.fill) {
      safe.fill = sanitizePaint(safe.fill);
    } else {
      delete safe.fill;
    }
  }
  if (safe.stroke) {
    safe.stroke = {
      ...safe.stroke,
      width: Number.isFinite(safe.stroke.width)
        ? Math.max(0, safe.stroke.width)
        : 0,
      ...(safe.stroke.paint
        ? { paint: sanitizePaint(safe.stroke.paint) }
        : {}),
    };
  }
  if (safe.effects) {
    safe.effects = safe.effects.map((effect) => {
      if (effect.type === "drop-shadow") {
        return {
          ...effect,
          dx: Number.isFinite(effect.dx) ? effect.dx : 0,
          dy: Number.isFinite(effect.dy) ? effect.dy : 0,
          blur: Number.isFinite(effect.blur) ? Math.max(0, effect.blur) : 0,
          opacity: Number.isFinite(effect.opacity)
            ? clamp(effect.opacity, 0, 1)
            : 1,
        };
      }
      if (effect.type === "outline") {
        return {
          ...effect,
          width: Number.isFinite(effect.width) ? Math.max(0, effect.width) : 0,
          opacity: Number.isFinite(effect.opacity)
            ? clamp(effect.opacity, 0, 1)
            : 1,
        };
      }
      if (effect.type === "glow") {
        return {
          ...effect,
          blur: Number.isFinite(effect.blur) ? Math.max(0, effect.blur) : 0,
          opacity: Number.isFinite(effect.opacity)
            ? clamp(effect.opacity, 0, 1)
            : 1,
        };
      }
      return {
        ...effect,
        size: Number.isFinite(effect.size) ? Math.max(0, effect.size) : 0,
        soften: Number.isFinite(effect.soften)
          ? Math.max(0, effect.soften)
          : 0,
        intensity: Number.isFinite(effect.intensity)
          ? clamp(effect.intensity, 0, 1)
          : 1,
      };
    });
  }
  if (
    safe.blendMode !== undefined &&
    !["multiply", "screen", "overlay", "darken", "lighten"].includes(
      safe.blendMode,
    )
  ) {
    delete safe.blendMode;
  }
  if (
    safe.fontStyle !== undefined &&
    safe.fontStyle !== "normal" &&
    safe.fontStyle !== "italic"
  ) {
    delete safe.fontStyle;
  }
  if (safe.onPath) {
    safe.onPath = {
      ...safe.onPath,
      startOffset: Number.isFinite(safe.onPath.startOffset)
        ? Math.max(0, safe.onPath.startOffset)
        : 0,
    };
  }
  if (safe.kerning) {
    safe.kerning = Object.fromEntries(
      Object.entries(safe.kerning).filter(
        ([index, value]) =>
          Number.isInteger(Number(index)) &&
          Number(index) >= 0 &&
          Number.isFinite(value),
      ),
    );
  }
  if (safe.otFeatures) {
    safe.otFeatures = Object.fromEntries(
      Object.entries(safe.otFeatures).filter(([tag]) =>
        /^[A-Za-z0-9]{4}$/.test(tag),
      ),
    );
  }
  if (safe.shape) {
    safe.shape = {
      ...safe.shape,
      ...(safe.shape.sides !== undefined
        ? {
            sides: Number.isFinite(safe.shape.sides)
              ? clamp(Math.round(safe.shape.sides), 3, 100)
              : 3,
          }
        : {}),
      ...(safe.shape.innerRatio !== undefined
        ? {
            innerRatio: Number.isFinite(safe.shape.innerRatio)
              ? clamp(safe.shape.innerRatio, 0.01, 0.99)
              : 0.45,
          }
        : {}),
    };
  }
  if (safe.geometry) {
    const finitePoint = (point: {
      x: number;
      y: number;
      handleIn?: { x: number; y: number };
      handleOut?: { x: number; y: number };
    }) =>
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      (!point.handleIn ||
        (Number.isFinite(point.handleIn.x) &&
          Number.isFinite(point.handleIn.y))) &&
      (!point.handleOut ||
        (Number.isFinite(point.handleOut.x) &&
          Number.isFinite(point.handleOut.y)));
    const valid = safe.geometry.subpaths.every(
      (subpath) =>
        subpath.points.length >= 2 && subpath.points.every(finitePoint),
    );
    if (!valid) {
      delete safe.geometry;
      delete safe.d;
    }
  }
  return safe;
}

function patchNode(node: LogoNode, patch: NodePatch): LogoNode {
  return { ...node, ...sanitizeNodePatch(node, patch) } as LogoNode;
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

function artboardIdForNode(
  document: LogoDocument,
  nodeId: string,
): string | null {
  const seen = new Set<string>();
  let current = nodeId;
  while (!seen.has(current)) {
    seen.add(current);
    const containerId = findContainerId(document, current);
    if (!containerId) {
      return null;
    }
    if (document.artboards.some((artboard) => artboard.id === containerId)) {
      return containerId;
    }
    current = containerId;
  }
  return null;
}

function artboardIdForContainer(
  document: LogoDocument,
  containerId: string,
): string | null {
  return document.artboards.some((artboard) => artboard.id === containerId)
    ? containerId
    : artboardIdForNode(document, containerId);
}

function isValidPaint(paint: Paint): boolean {
  if (paint.type === "solid") {
    return typeof paint.color === "string";
  }
  if (
    paint.stops.some(
      (stop) =>
        !Number.isFinite(stop.offset) ||
        stop.offset < 0 ||
        stop.offset > 1 ||
        (stop.alpha !== undefined &&
          (!Number.isFinite(stop.alpha) ||
            stop.alpha < 0 ||
            stop.alpha > 1)),
    )
  ) {
    return false;
  }
  if (paint.type === "linear-gradient") {
    return (
      Number.isFinite(paint.angle) &&
      ((!paint.start && !paint.end) ||
        Boolean(
          paint.start &&
            paint.end &&
            Number.isFinite(paint.start.x) &&
            Number.isFinite(paint.start.y) &&
            Number.isFinite(paint.end.x) &&
            Number.isFinite(paint.end.y),
        ))
    );
  }
  return (
    Number.isFinite(paint.cx) &&
    Number.isFinite(paint.cy) &&
    Number.isFinite(paint.r) &&
    paint.r >= 0 &&
    (paint.fx === undefined || Number.isFinite(paint.fx)) &&
    (paint.fy === undefined || Number.isFinite(paint.fy))
  );
}

function isValidIncomingNode(node: LogoNode): boolean {
  if (
    !Number.isFinite(node.x) ||
    !Number.isFinite(node.y) ||
    !Number.isFinite(node.width) ||
    node.width <= 0 ||
    !Number.isFinite(node.height) ||
    node.height <= 0 ||
    !Number.isFinite(node.rotation) ||
    !Number.isFinite(node.opacity) ||
    node.opacity < 0 ||
    node.opacity > 1 ||
    !isValidPaint(node.fill) ||
    (node.stroke &&
      (!Number.isFinite(node.stroke.width) ||
        node.stroke.width < 0 ||
        (node.stroke.paint && !isValidPaint(node.stroke.paint))))
  ) {
    return false;
  }
  if (node.type === "rectangle") {
    return Number.isFinite(node.cornerRadius) && node.cornerRadius >= 0;
  }
  if (node.type === "path") {
    return (
      Number.isFinite(node.intrinsicWidth) &&
      node.intrinsicWidth > 0 &&
      Number.isFinite(node.intrinsicHeight) &&
      node.intrinsicHeight > 0
    );
  }
  if (node.type === "text") {
    return (
      Number.isFinite(node.fontSize) &&
      node.fontSize > 0 &&
      Number.isFinite(node.fontWeight) &&
      Number.isFinite(node.letterSpacing) &&
      Number.isFinite(node.lineHeight) &&
      node.lineHeight > 0 &&
      (!node.onPath ||
        (Number.isFinite(node.onPath.startOffset) &&
          node.onPath.startOffset >= 0))
    );
  }
  return true;
}

/** A command whose application threw — a malformed command or a model bug. */
export class CommandApplyError extends Data.TaggedError("CommandApplyError")<{
  readonly command: Command;
  readonly cause: unknown;
}> {}

/**
 * Effect wrapper over `applyCommand` for callers that must not let a
 * throwing command corrupt state (DocumentStore history). `applyCommand`
 * itself stays the pure, synchronous primitive — fuzz suites and per-frame
 * callers use it directly.
 */
export const applyCommandEffect = (
  document: LogoDocument,
  command: Command,
): Fx.Effect<ApplyResult, CommandApplyError> =>
  Fx.try({
    try: () => applyCommand(document, command),
    catch: (cause) => new CommandApplyError({ command, cause }),
  });

export function applyCommand(
  document: LogoDocument,
  command: Command,
): ApplyResult {
  switch (command.type) {
    case "insert-nodes": {
      const targetContainerId = command.containerId ?? command.artboardId;
      const targetContainer = containerListOf(document, targetContainerId);
      const targetArtboardId = artboardIdForContainer(
        document,
        targetContainerId,
      );
      const ids = command.nodes.map((node) => node.id);
      const uniqueIds = new Set(ids);
      if (
        command.nodes.length === 0 ||
        command.nodes.some((node) => !isValidIncomingNode(node)) ||
        !targetContainer ||
        !targetArtboardId ||
        targetArtboardId !== command.artboardId ||
        uniqueIds.size !== ids.length ||
        ids.some(
          (id) =>
            document.nodes[id] !== undefined ||
            document.artboards.some((artboard) => artboard.id === id),
        )
      ) {
        return { document, inverse: command };
      }

      const incoming = new Map(command.nodes.map((node) => [node.id, node]));
      const claimedChildren = new Set<string>();
      let validTree = true;
      for (const node of command.nodes) {
        if (node.type === "group") {
          for (const childId of node.children) {
            if (
              !incoming.has(childId) ||
              childId === node.id ||
              claimedChildren.has(childId)
            ) {
              validTree = false;
              break;
            }
            claimedChildren.add(childId);
          }
          if (node.clippingMaskId) {
            const mask = incoming.get(node.clippingMaskId);
            if (
              !node.children.includes(node.clippingMaskId) ||
              (mask?.type !== "rectangle" &&
                mask?.type !== "ellipse" &&
                mask?.type !== "path")
            ) {
              validTree = false;
            }
          }
        }
        if (node.type === "text" && node.onPath) {
          const path =
            incoming.get(node.onPath.pathId) ??
            document.nodes[node.onPath.pathId];
          if (
            path?.type !== "path" ||
            (!incoming.has(node.onPath.pathId) &&
              artboardIdForNode(document, node.onPath.pathId) !==
                targetArtboardId)
          ) {
            validTree = false;
          }
        }
      }

      const rootIds = ids.filter((id) => !claimedChildren.has(id));
      const visited = new Set<string>();
      const visiting = new Set<string>();
      const visitIncoming = (id: string): boolean => {
        if (visiting.has(id)) {
          return false;
        }
        if (visited.has(id)) {
          return true;
        }
        visiting.add(id);
        const node = incoming.get(id);
        if (
          !node ||
          (node.type === "group" &&
            !node.children.every((childId) => visitIncoming(childId)))
        ) {
          return false;
        }
        visiting.delete(id);
        visited.add(id);
        return true;
      };
      if (
        !validTree ||
        rootIds.length === 0 ||
        !rootIds.every(visitIncoming) ||
        visited.size !== command.nodes.length
      ) {
        return { document, inverse: command };
      }

      const nodes = { ...document.nodes };
      for (const node of command.nodes) {
        nodes[node.id] = node;
      }
      const containerId = targetContainerId;
      const list = [...targetContainer];
      list.splice(
        Math.max(0, Math.min(command.index ?? list.length, list.length)),
        0,
        ...rootIds,
      );
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
      if (removed.size === 0) {
        return { document, inverse: command };
      }

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

      const clippingMasks: Array<{ groupId: string; maskId: string }> = [];
      const textPaths: Array<{
        textId: string;
        attachment: TextPathAttachment;
      }> = [];
      for (const node of Object.values(document.nodes)) {
        if (
          !removed.has(node.id) &&
          node.type === "group" &&
          node.clippingMaskId &&
          removed.has(node.clippingMaskId)
        ) {
          clippingMasks.push({
            groupId: node.id,
            maskId: node.clippingMaskId,
          });
        }
        if (
          !removed.has(node.id) &&
          node.type === "text" &&
          node.onPath &&
          removed.has(node.onPath.pathId)
        ) {
          textPaths.push({
            textId: node.id,
            attachment: { ...node.onPath },
          });
        }
      }

      const nodes = { ...document.nodes };
      for (const nodeId of removed) {
        delete nodes[nodeId];
      }
      // Surviving groups drop removed children; relationship owners also
      // clear references to deleted masks and text paths.
      for (const [id, node] of Object.entries(nodes)) {
        if (node.type === "group") {
          const next = {
            ...node,
            children: node.children.filter((childId) => !removed.has(childId)),
          };
          if (next.clippingMaskId && removed.has(next.clippingMaskId)) {
            const { clippingMaskId: _removedMask, ...withoutMask } = next;
            nodes[id] = withoutMask;
          } else if (next.children.length !== node.children.length) {
            nodes[id] = next;
          }
        } else if (
          node.type === "text" &&
          node.onPath &&
          removed.has(node.onPath.pathId)
        ) {
          const { onPath: _removedPath, ...withoutPath } = node;
          nodes[id] = withoutPath;
        }
      }

      const artboards = document.artboards.map((artboard) => ({
        ...artboard,
        nodeIds: artboard.nodeIds.filter((nodeId) => !removed.has(nodeId)),
      }));

      return {
        document: { ...document, nodes, artboards },
        inverse: {
          type: "restore-nodes",
          entries,
          ...(clippingMasks.length > 0 ? { clippingMasks } : {}),
          ...(textPaths.length > 0 ? { textPaths } : {}),
        },
      };
    }

    case "restore-nodes": {
      const entryIds = command.entries.map((entry) => entry.node.id);
      const uniqueEntryIds = new Set(entryIds);
      const prospectiveNodes: Record<string, LogoNode> = {
        ...document.nodes,
        ...Object.fromEntries(
          command.entries.map((entry) => [entry.node.id, entry.node]),
        ),
      };
      const containerWillExist = (containerId: string): boolean =>
        document.artboards.some((artboard) => artboard.id === containerId) ||
        prospectiveNodes[containerId]?.type === "group";
      if (
        command.entries.length === 0 ||
        uniqueEntryIds.size !== entryIds.length ||
        entryIds.some(
          (id) =>
            document.nodes[id] !== undefined ||
            document.artboards.some((artboard) => artboard.id === id),
        ) ||
        command.entries.some((entry) => !isValidIncomingNode(entry.node)) ||
        command.entries.some(
          (entry) =>
            entry.containerId === entry.node.id ||
            !containerWillExist(entry.containerId),
        )
      ) {
        return { document, inverse: command };
      }

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
            list.splice(
              Math.max(0, Math.min(item.index, list.length)),
              0,
              item.id,
            );
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

      for (const relation of command.clippingMasks ?? []) {
        const group = nodes[relation.groupId];
        const mask = nodes[relation.maskId];
        if (
          group?.type === "group" &&
          group.children.includes(relation.maskId) &&
          (mask?.type === "rectangle" ||
            mask?.type === "ellipse" ||
            mask?.type === "path")
        ) {
          nodes[group.id] = { ...group, clippingMaskId: relation.maskId };
        }
      }
      for (const relation of command.textPaths ?? []) {
        const text = nodes[relation.textId];
        if (
          text?.type === "text" &&
          nodes[relation.attachment.pathId]?.type === "path"
        ) {
          nodes[text.id] = {
            ...text,
            onPath: { ...relation.attachment },
          };
        }
      }

      const claimed = new Set<string>();
      const visiting = new Set<string>();
      const visit = (id: string): boolean => {
        if (claimed.has(id) || visiting.has(id) || !nodes[id]) {
          return false;
        }
        visiting.add(id);
        const node = nodes[id]!;
        if (
          node.type === "group" &&
          !node.children.every((childId) => visit(childId))
        ) {
          return false;
        }
        visiting.delete(id);
        claimed.add(id);
        return true;
      };
      if (
        !artboards.every((artboard) => artboard.nodeIds.every(visit)) ||
        entryIds.some((id) => !claimed.has(id))
      ) {
        return { document, inverse: command };
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
        const patch = sanitizeNodePatch(node, update.patch);
        if (
          patch.onPath &&
          (node.type !== "text" ||
            document.nodes[patch.onPath.pathId]?.type !== "path" ||
            artboardIdForNode(document, patch.onPath.pathId) !==
              artboardIdForNode(document, node.id))
        ) {
          delete patch.onPath;
        }
        if (Object.keys(patch).length === 0) {
          continue;
        }
        inverseUpdates.push({
          nodeId: update.nodeId,
          patch: pickInversePatch(node, patch),
        });
        nodes[update.nodeId] = patchNode(node, patch);
      }
      if (inverseUpdates.length === 0) {
        return { document, inverse: command };
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
      next.splice(
        Math.max(0, Math.min(command.toIndex, next.length)),
        0,
        command.nodeId,
      );

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
        next.splice(
          Math.max(0, Math.min(command.toIndex, next.length)),
          0,
          command.nodeId,
        );
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
          Math.max(0, Math.min(command.toIndex, targetNext.length)),
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
      if (
        !list ||
        document.nodes[group.id] !== undefined ||
        document.artboards.some((artboard) => artboard.id === group.id) ||
        group.children.length === 0 ||
        new Set(group.children).size !== group.children.length
      ) {
        return { document, inverse: command };
      }

      // A clipping relationship is valid only inside the group that owns it.
      // Reject malformed commands before touching the tree so editor-level
      // operations remain atomic even if a future caller skips validation.
      const clippingMask = group.clippingMaskId
        ? document.nodes[group.clippingMaskId]
        : undefined;
      if (
        group.children.some((childId) => !list.includes(childId)) ||
        (group.clippingMaskId !== undefined &&
          (!group.children.includes(group.clippingMaskId) ||
            (clippingMask?.type !== "rectangle" &&
              clippingMask?.type !== "ellipse" &&
              clippingMask?.type !== "path")))
      ) {
        return { document, inverse: command };
      }

      // Pair-wise with group.children so the inverse can put each child
      // back at its exact pre-group container index.
      const restoreIndices = group.children.map((childId) =>
        list.indexOf(childId),
      );

      const childSet = new Set(group.children);
      const next = list.filter((id) => !childSet.has(id));
      next.splice(
        Math.max(0, Math.min(command.index, next.length)),
        0,
        group.id,
      );

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
          next.splice(
            Math.max(0, Math.min(pair.index, next.length)),
            0,
            pair.id,
          );
        }
      } else {
        next.splice(Math.max(0, fromIndex), 0, ...group.children);
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
      const incoming = new Map<string, LogoNode>();
      let validTree =
        !document.artboards.some(
          (artboard) => artboard.id === command.artboard.id,
        ) &&
        document.nodes[command.artboard.id] === undefined &&
        Number.isFinite(command.artboard.x) &&
        Number.isFinite(command.artboard.y) &&
        Number.isFinite(command.artboard.width) &&
        command.artboard.width > 0 &&
        Number.isFinite(command.artboard.height) &&
        command.artboard.height > 0;
      for (const node of command.nodes) {
        if (
          !isValidIncomingNode(node) ||
          incoming.has(node.id) ||
          document.nodes[node.id] ||
          document.artboards.some(
            (artboard) =>
              artboard.id === node.id || artboard.id === command.artboard.id,
          ) ||
          node.id === command.artboard.id
        ) {
          validTree = false;
        }
        incoming.set(node.id, node);
      }
      const roots = command.artboard.nodeIds;
      if (
        new Set(roots).size !== roots.length ||
        roots.some((id) => !incoming.has(id))
      ) {
        validTree = false;
      }
      const visited = new Set<string>();
      const visiting = new Set<string>();
      const visit = (id: string): boolean => {
        if (visiting.has(id) || visited.has(id)) {
          return false;
        }
        const node = incoming.get(id);
        if (!node) {
          return false;
        }
        visiting.add(id);
        if (node.type === "group") {
          if (
            new Set(node.children).size !== node.children.length ||
            !node.children.every(visit)
          ) {
            return false;
          }
          if (node.clippingMaskId) {
            const mask = incoming.get(node.clippingMaskId);
            if (
              !node.children.includes(node.clippingMaskId) ||
              (mask?.type !== "rectangle" &&
                mask?.type !== "ellipse" &&
                mask?.type !== "path")
            ) {
              return false;
            }
          }
        } else if (node.type === "text" && node.onPath) {
          if (incoming.get(node.onPath.pathId)?.type !== "path") {
            return false;
          }
        }
        visiting.delete(id);
        visited.add(id);
        return true;
      };
      if (
        !validTree ||
        !roots.every(visit) ||
        visited.size !== command.nodes.length
      ) {
        return { document, inverse: command };
      }

      const nodes = { ...document.nodes };
      for (const node of command.nodes) {
        nodes[node.id] = node;
      }

      const artboards = [...document.artboards];
      artboards.splice(
        Math.max(
          0,
          Math.min(command.index ?? artboards.length, artboards.length),
        ),
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
      if (!previous) {
        return { document, inverse: command };
      }
      const patch = { ...command.patch };
      for (const key of ["x", "y"] as const) {
        const value = patch[key];
        if (value !== undefined && !Number.isFinite(value)) {
          delete patch[key];
        }
      }
      for (const key of ["width", "height"] as const) {
        const value = patch[key];
        if (value !== undefined) {
          if (Number.isFinite(value)) {
            patch[key] = Math.max(1, value);
          } else {
            delete patch[key];
          }
        }
      }
      if (patch.guides) {
        patch.guides = {
          v: patch.guides.v.filter(Number.isFinite),
          h: patch.guides.h.filter(Number.isFinite),
        };
      }
      if (Object.keys(patch).length === 0) {
        return { document, inverse: command };
      }
      const inversePatch: Record<string, unknown> = {};

      for (const key of Object.keys(patch)) {
        inversePatch[key] = (previous as unknown as Record<string, unknown>)[
          key
        ];
      }

      return {
        document: {
          ...document,
          artboards: document.artboards.map((item) =>
            item.id === command.artboardId ? { ...item, ...patch } : item,
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
        Math.max(0, Math.min(command.toIndex, artboards.length)),
        0,
        document.artboards[fromIndex]!,
      );

      return {
        document: { ...document, artboards },
        inverse: { ...command, toIndex: fromIndex },
      };
    }

    case "set-active-artboard": {
      if (
        !document.artboards.some(
          (artboard) => artboard.id === command.artboardId,
        )
      ) {
        return { document, inverse: command };
      }
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
