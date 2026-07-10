import {
  type AnchorRef,
  type PathGeometry,
  type PathNode,
  type Vec2,
  joinAnchors,
  getClippingMaskOwnerId,
  pathGeometryToSvg,
  pathNodeLocalGeometry,
} from "@openlogo/core";
import { patchFromLocalGeometry } from "./path-node-geometry";
import { documentStore } from "../state/document";

/** Open-subpath endpoint anchors of a geometry with their positions. */
function openEndpoints(
  geometry: PathGeometry,
): Array<{ ref: AnchorRef; point: Vec2 }> {
  const out: Array<{ ref: AnchorRef; point: Vec2 }> = [];
  for (const [si, subpath] of geometry.subpaths.entries()) {
    if (subpath.closed || subpath.points.length < 2) {
      continue;
    }
    const first = subpath.points[0]!;
    const last = subpath.points[subpath.points.length - 1]!;
    out.push({ ref: { subpath: si, index: 0 }, point: first });
    out.push({
      ref: { subpath: si, index: subpath.points.length - 1 },
      point: last,
    });
  }
  return out;
}

function isJoinablePath(node: unknown): node is PathNode {
  return (
    Boolean(node) &&
    (node as PathNode).type === "path" &&
    Boolean((node as PathNode).geometry)
  );
}

/**
 * ⌘J in normal selection mode (Illustrator Join).
 *
 * One open path selected → its endpoints connect: the subpath closes,
 * welding coincident ends (this is what reconnects a scissors cut).
 * Two paths selected → they merge into the first node, joining the
 * NEAREST pair of open endpoints across the two; the second node is
 * deleted. Everything commits as one undoable entry.
 *
 * Cross-node joins require both nodes unrotated (geometry merges in
 * artboard space; rotation is not baked). Returns the surviving ids.
 */
export function joinSelectedPaths(
  nodeIds: readonly string[],
): string[] | null {
  const document = documentStore.document;
  const nodes = nodeIds
    .map((id) => document.nodes[id])
    .filter(isJoinablePath);

  if (nodes.length === 1) {
    const node = nodes[0]!;
    const geometry = node.geometry!;
    const openIndex = geometry.subpaths.findIndex(
      (subpath) => !subpath.closed && subpath.points.length >= 2,
    );
    if (openIndex === -1) {
      return null;
    }
    const joined = joinAnchors(
      geometry,
      { subpath: openIndex, index: 0 },
      {
        subpath: openIndex,
        index: geometry.subpaths[openIndex]!.points.length - 1,
      },
    );
    if (!joined) {
      return null;
    }
    // Anchors never move on a same-subpath join: the box is unchanged,
    // so this stays a pure intrinsic-space patch.
    documentStore.apply({
      type: "update-nodes",
      updates: [
        {
          nodeId: node.id,
          patch: { geometry: joined, d: pathGeometryToSvg(joined) },
        },
      ],
    });
    return [node.id];
  }

  if (nodes.length !== 2) {
    return null;
  }
  const [a, b] = nodes as [PathNode, PathNode];
  if (
    a.rotation !== 0 ||
    b.rotation !== 0 ||
    getClippingMaskOwnerId(document, a.id) !== null ||
    getClippingMaskOwnerId(document, b.id) !== null
  ) {
    return null;
  }

  const localA = pathNodeLocalGeometry(a);
  const localB = pathNodeLocalGeometry(b);
  if (!localA || !localB) {
    return null;
  }

  const combined: PathGeometry = {
    subpaths: [...localA.subpaths, ...localB.subpaths],
  };
  const offsetB = localA.subpaths.length;
  const endsA = openEndpoints(localA);
  const endsB = openEndpoints(localB).map((end) => ({
    point: end.point,
    ref: { subpath: end.ref.subpath + offsetB, index: end.ref.index },
  }));
  if (endsA.length === 0 || endsB.length === 0) {
    return null;
  }

  let best: { a: AnchorRef; b: AnchorRef; distance: number } | null = null;
  for (const endA of endsA) {
    for (const endB of endsB) {
      const distance = Math.hypot(
        endA.point.x - endB.point.x,
        endA.point.y - endB.point.y,
      );
      if (!best || distance < best.distance) {
        best = { a: endA.ref, b: endB.ref, distance };
      }
    }
  }

  const joined = best && joinAnchors(combined, best.a, best.b);
  if (!joined) {
    return null;
  }
  const patch = patchFromLocalGeometry(joined);
  if (!patch) {
    return null;
  }

  documentStore.apply({
    type: "batch",
    label: "Join",
    commands: [
      { type: "update-nodes", updates: [{ nodeId: a.id, patch }] },
      { type: "delete-nodes", nodeIds: [b.id] },
    ],
  });
  return [a.id];
}
