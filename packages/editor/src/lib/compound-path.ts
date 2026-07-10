import {
  type LogoDocument,
  type LogoNode,
  type PathGeometry,
  type PathNode,
  createId,
  findContainerId,
  getContainerChildIds,
  getClippingMaskOwnerId,
  rotatePoint,
} from "@openlogo/core";
import { compoundNodes } from "@openlogo/renderer";
import { getCanvasKit } from "./canvaskit";
import { sortBySceneOrder } from "./group-ops";
import { documentStore } from "../state/document";
import { patchFromLocalGeometry } from "./path-node-geometry";

type PathLikeNode = Extract<
  LogoNode,
  { type: "rectangle" | "ellipse" | "path" }
>;

type CompoundOperands = {
  nodes: PathLikeNode[];
  containerId: string;
  artboardId: string;
  insertIndex: number;
};

function isPathLike(node: LogoNode | undefined): node is PathLikeNode {
  return (
    node?.type === "rectangle" ||
    node?.type === "ellipse" ||
    node?.type === "path"
  );
}

function hasLockedAncestor(document: LogoDocument, nodeId: string): boolean {
  let containerId = findContainerId(document, nodeId);
  const seen = new Set<string>();

  while (containerId && !seen.has(containerId)) {
    seen.add(containerId);
    const container = document.nodes[containerId];
    if (!container) {
      return false; // Reached an artboard.
    }
    if (container.type !== "group") {
      return true; // Malformed container graph: fail closed.
    }
    if (container.locked) {
      return true;
    }
    containerId = findContainerId(document, container.id);
  }

  return containerId !== null; // A cycle is malformed: fail closed.
}

function isFiniteGeometry(geometry: PathGeometry): boolean {
  const finitePoint = (point: { x: number; y: number }) =>
    Number.isFinite(point.x) && Number.isFinite(point.y);

  return geometry.subpaths.every(
    (subpath) =>
      subpath.points.length > 0 &&
      subpath.points.every(
        (point) =>
          finitePoint(point) &&
          (!point.handleIn || finitePoint(point.handleIn)) &&
          (!point.handleOut || finitePoint(point.handleOut)),
      ),
  );
}

function containingArtboardId(
  document: LogoDocument,
  containerId: string,
): string | null {
  let current: string | null = containerId;
  const seen = new Set<string>();

  while (current && !seen.has(current)) {
    if (document.artboards.some((artboard) => artboard.id === current)) {
      return current;
    }
    seen.add(current);
    current = findContainerId(document, current);
  }
  return null;
}

function resolveOperands(
  document: LogoDocument,
  selectedNodeIds: readonly string[],
): CompoundOperands | null {
  const uniqueIds = [...new Set(selectedNodeIds)];
  if (uniqueIds.length < 2 || uniqueIds.length !== selectedNodeIds.length) {
    return null;
  }

  const orderedIds = sortBySceneOrder(document, uniqueIds);
  const nodes = orderedIds.map((id) => document.nodes[id]);
  if (
    nodes.some(
      (node) =>
        !isPathLike(node) ||
        node.locked ||
        getClippingMaskOwnerId(document, node.id) !== null ||
        hasLockedAncestor(document, node.id),
    ) ||
    nodes.length !== orderedIds.length
  ) {
    return null;
  }

  const pathNodes = nodes as PathLikeNode[];
  // Text attachments do not identify a subpath. Simplifying a compound source
  // may also reorder its contours, so no attachment can be retargeted safely
  // until TextPathAttachment gains a stable subpath identity.
  const operandIds = new Set(pathNodes.map((node) => node.id));
  if (
    Object.values(document.nodes).some(
      (node) =>
        node.type === "text" &&
        node.onPath &&
        operandIds.has(node.onPath.pathId),
    )
  ) {
    return null;
  }

  const containers = new Set(
    pathNodes.map((node) => findContainerId(document, node.id)),
  );
  const containerId = [...containers][0];
  if (containers.size !== 1 || !containerId) {
    return null;
  }

  const siblings = getContainerChildIds(document, containerId);
  const indices = pathNodes.map((node) => siblings.indexOf(node.id));
  if (indices.some((index) => index < 0)) {
    return null;
  }

  const artboardId = containingArtboardId(document, containerId);
  if (!artboardId) {
    return null;
  }

  return {
    nodes: pathNodes,
    containerId,
    artboardId,
    insertIndex: Math.min(...indices),
  };
}

export function canMakeCompoundPath(
  selectedNodeIds: readonly string[],
): boolean {
  return resolveOperands(documentStore.document, selectedNodeIds) !== null;
}

/**
 * Make one even-odd compound path from selected sibling shapes. Conversion
 * finishes before any command runs, so every failure leaves operands intact.
 */
export async function makeCompoundPath(
  selectedNodeIds: readonly string[],
): Promise<string | null> {
  const document = documentStore.document;
  if (document !== documentStore.committedDocument) {
    return null;
  }

  const operands = resolveOperands(document, selectedNodeIds);
  if (!operands) {
    return null;
  }

  const canvasKit = await getCanvasKit();
  const result = compoundNodes(canvasKit, operands.nodes);
  if (!result || documentStore.document !== document) {
    return null;
  }

  const source = operands.nodes[0]!;
  const compound: PathNode = {
    id: createId("node"),
    type: "path",
    name: "Compound path",
    x: result.x,
    y: result.y,
    width: result.width,
    height: result.height,
    rotation: 0,
    opacity: source.opacity,
    visible: source.visible,
    locked: false,
    fill: structuredClone(source.fill),
    ...(source.stroke ? { stroke: structuredClone(source.stroke) } : {}),
    ...(source.blendMode ? { blendMode: source.blendMode } : {}),
    ...(source.effects ? { effects: structuredClone(source.effects) } : {}),
    d: result.d,
    fillRule: result.fillRule,
    geometry: result.geometry,
    intrinsicWidth: result.width,
    intrinsicHeight: result.height,
  };

  documentStore.apply({
    type: "batch",
    label: "Make compound path",
    commands: [
      {
        type: "delete-nodes",
        nodeIds: operands.nodes.map((node) => node.id),
      },
      {
        type: "insert-nodes",
        artboardId: operands.artboardId,
        ...(operands.containerId !== operands.artboardId
          ? { containerId: operands.containerId }
          : {}),
        nodes: [compound],
        index: operands.insertIndex,
      },
    ],
  });
  return documentStore.document.nodes[compound.id]?.type === "path"
    ? compound.id
    : null;
}

type ReleaseTarget = {
  node: PathNode;
  geometry: PathGeometry;
  containerId: string;
  artboardId: string;
  insertIndex: number;
};

function resolveReleaseTarget(
  document: LogoDocument,
  selectedNodeIds: readonly string[],
): ReleaseTarget | null {
  if (selectedNodeIds.length !== 1) {
    return null;
  }
  const node = document.nodes[selectedNodeIds[0]!];
  if (
    node?.type !== "path" ||
    node.locked ||
    getClippingMaskOwnerId(document, node.id) !== null ||
    hasLockedAncestor(document, node.id)
  ) {
    return null;
  }
  if (
    !Number.isFinite(node.x) ||
    !Number.isFinite(node.y) ||
    !Number.isFinite(node.width) ||
    !Number.isFinite(node.height) ||
    !Number.isFinite(node.intrinsicWidth) ||
    !Number.isFinite(node.intrinsicHeight) ||
    !Number.isFinite(node.rotation) ||
    node.width <= 0 ||
    node.height <= 0 ||
    node.intrinsicWidth <= 0 ||
    node.intrinsicHeight <= 0
  ) {
    return null;
  }
  const geometry = node.geometry;
  if (
    !geometry ||
    geometry.subpaths.length < 2 ||
    !isFiniteGeometry(geometry)
  ) {
    return null;
  }
  if (
    Object.values(document.nodes).some(
      (candidate) =>
        candidate.type === "text" && candidate.onPath?.pathId === node.id,
    )
  ) {
    return null;
  }

  const containerId = findContainerId(document, node.id);
  if (!containerId) {
    return null;
  }
  const artboardId = containingArtboardId(document, containerId);
  const insertIndex = getContainerChildIds(document, containerId).indexOf(node.id);
  if (!artboardId || insertIndex < 0) {
    return null;
  }
  return { node, geometry, containerId, artboardId, insertIndex };
}

export function canReleaseCompoundPath(
  selectedNodeIds: readonly string[],
): boolean {
  return resolveReleaseTarget(documentStore.document, selectedNodeIds) !== null;
}

/**
 * Split an editable multi-contour path into independent sibling Path Nodes.
 * Each piece keeps the source path's intrinsic-to-artboard scale and rotation.
 * Its centre is translated from the source pivot to the released piece's own
 * pivot, preserving every rendered point and the transformed stroke width.
 */
export function releaseCompoundPath(
  selectedNodeIds: readonly string[],
): string[] | null {
  const document = documentStore.document;
  if (document !== documentStore.committedDocument) {
    return null;
  }
  const target = resolveReleaseTarget(document, selectedNodeIds);
  if (!target) {
    return null;
  }

  const pivot = {
    x: target.node.x + target.node.width / 2,
    y: target.node.y + target.node.height / 2,
  };
  const sx = target.node.width / target.node.intrinsicWidth;
  const sy = target.node.height / target.node.intrinsicHeight;
  const patches = target.geometry.subpaths.map((subpath) =>
    patchFromLocalGeometry({ subpaths: [subpath] }),
  );
  if (patches.some((patch) => !patch)) {
    return null;
  }

  const released: PathNode[] = patches.map((patch, index) => {
    const width = patch!.width! * sx;
    const height = patch!.height! * sy;
    const unrotatedCenter = {
      x: target.node.x + (patch!.x! + patch!.width! / 2) * sx,
      y: target.node.y + (patch!.y! + patch!.height! / 2) * sy,
    };
    const center = rotatePoint(
      unrotatedCenter,
      pivot,
      target.node.rotation,
    );
    const {
      id: _id,
      name: _name,
      x: _x,
      y: _y,
      width: _width,
      height: _height,
      rotation: _rotation,
      d: _d,
      intrinsicWidth: _intrinsicWidth,
      intrinsicHeight: _intrinsicHeight,
      geometry: _geometry,
      shape: _shape,
      ...appearance
    } = structuredClone(target.node);
    return {
      ...appearance,
      id: createId("node"),
      name: `${target.node.name} ${index + 1}`,
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
      rotation: target.node.rotation,
      d: patch!.d!,
      intrinsicWidth: patch!.intrinsicWidth!,
      intrinsicHeight: patch!.intrinsicHeight!,
      geometry: patch!.geometry!,
    };
  });

  documentStore.apply({
    type: "batch",
    label: "Release compound path",
    commands: [
      { type: "delete-nodes", nodeIds: [target.node.id] },
      {
        type: "insert-nodes",
        artboardId: target.artboardId,
        ...(target.containerId !== target.artboardId
          ? { containerId: target.containerId }
          : {}),
        nodes: released,
        index: target.insertIndex,
      },
    ],
  });

  const ids = released
    .map((node) => node.id)
    .filter((id) => documentStore.document.nodes[id]?.type === "path");
  return ids.length === released.length ? ids : null;
}
