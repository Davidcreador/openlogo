import { type Vec2, rotatePoint } from "./geometry";
import {
  pathGeometryToSvg,
  scalePathGeometry,
  translatePathGeometry,
} from "./path-data";
import type { NodePatch } from "./commands";
import { collectLeafNodeIds } from "./queries";
import type { LogoDocument } from "./types";

/**
 * Leaf-level transform patch builders (rotate / reflect / scale /
 * translate). These are the shared math behind the on-canvas rotate
 * handle, the rotate/reflect dialog and Transform Again: pure functions
 * from a document + selection to `update-nodes` updates, so the whole
 * transform commits as ONE exact-inverse command.
 *
 * All angles are degrees; pivots and axes are artboard-local. Locked
 * leaves are skipped, matching every other object operation.
 */

export type LeafUpdate = { nodeId: string; patch: NodePatch };

/** Normalize an angle to (-180, 180]. */
export function normalizeAngle(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/**
 * Rotate the selection's leaves by `degrees` around `pivot`: every leaf
 * centre orbits the pivot and the leaf's own rotation increments.
 */
export function rotateLeafPatches(
  document: LogoDocument,
  nodeIds: readonly string[],
  degrees: number,
  pivot: Vec2,
): LeafUpdate[] {
  if (degrees === 0) {
    return [];
  }
  return collectLeafNodeIds(document, nodeIds)
    .map((nodeId) => {
      const node = document.nodes[nodeId];
      if (!node || node.locked) {
        return null;
      }
      const center = rotatePoint(
        { x: node.x + node.width / 2, y: node.y + node.height / 2 },
        pivot,
        degrees,
      );
      const patch: NodePatch = {
        x: center.x - node.width / 2,
        y: center.y - node.height / 2,
        rotation: normalizeAngle(node.rotation + degrees),
      };
      return { nodeId, patch };
    })
    .filter((update): update is LeafUpdate => update !== null);
}

/** Reflect a point across the line through `pivot` at `axisAngle`°. */
export function reflectPoint(
  point: Vec2,
  pivot: Vec2,
  axisAngle: number,
): Vec2 {
  const radians = (2 * axisAngle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;
  return {
    x: pivot.x + dx * cos + dy * sin,
    y: pivot.y + dx * sin - dy * cos,
  };
}

/**
 * Reflect the selection's leaves across the mirror line through `pivot`
 * at `axisAngle` degrees (0 = horizontal line → flips up/down, 90 =
 * vertical line → flips left/right).
 *
 * Decomposition per leaf: the mirrored appearance of a box node rotated
 * by θ equals content-flipped-vertically + rotation (2·axis − θ), with
 * the centre reflected across the line. Paths with structured geometry
 * flip their intrinsic content; rectangles/ellipses are symmetric under
 * the flip. Text (and geometry-less paths) cannot flip their content, so
 * they keep the decomposition whose angle stays most upright — the same
 * approximation the existing flip buttons use.
 */
export function reflectLeafPatches(
  document: LogoDocument,
  nodeIds: readonly string[],
  axisAngle: number,
  pivot: Vec2,
): LeafUpdate[] {
  return collectLeafNodeIds(document, nodeIds)
    .map((nodeId) => {
      const node = document.nodes[nodeId];
      if (!node || node.locked) {
        return null;
      }

      const center = reflectPoint(
        { x: node.x + node.width / 2, y: node.y + node.height / 2 },
        pivot,
        axisAngle,
      );
      const patch: NodePatch = {
        x: center.x - node.width / 2,
        y: center.y - node.height / 2,
      };

      const flippedRotation = normalizeAngle(2 * axisAngle - node.rotation);
      if (node.type === "path" && node.geometry) {
        // Flip the intrinsic content vertically; the rotation carries
        // the rest of the mirror.
        const mirrored = translatePathGeometry(
          scalePathGeometry(node.geometry, 1, -1),
          0,
          node.intrinsicHeight,
        );
        patch.geometry = mirrored;
        patch.d = pathGeometryToSvg(mirrored);
        patch.rotation = flippedRotation;
      } else if (node.type === "rectangle" || node.type === "ellipse") {
        // Content is symmetric under the vertical flip.
        patch.rotation = flippedRotation;
      } else {
        // Text / legacy paths: content cannot mirror — pick the
        // decomposition that keeps the node most upright.
        const alternate = normalizeAngle(flippedRotation - 180);
        patch.rotation =
          Math.abs(alternate) < Math.abs(flippedRotation)
            ? alternate
            : flippedRotation;
      }

      return { nodeId, patch };
    })
    .filter((update): update is LeafUpdate => update !== null);
}

/**
 * Scale the selection's leaves by (sx, sy) anchored at `pivot`. Text
 * nodes scale their font size with sy, matching corner-handle resizes.
 */
export function scaleLeafPatches(
  document: LogoDocument,
  nodeIds: readonly string[],
  sx: number,
  sy: number,
  pivot: Vec2,
): LeafUpdate[] {
  if (sx <= 0 || sy <= 0 || (sx === 1 && sy === 1)) {
    return [];
  }
  return collectLeafNodeIds(document, nodeIds)
    .map((nodeId) => {
      const node = document.nodes[nodeId];
      if (!node || node.locked) {
        return null;
      }
      const patch: NodePatch = {
        x: pivot.x + (node.x - pivot.x) * sx,
        y: pivot.y + (node.y - pivot.y) * sy,
        width: Math.max(0.01, node.width * sx),
        height: Math.max(0.01, node.height * sy),
      };
      if (node.type === "text" && sy !== 1) {
        patch.fontSize = Math.max(6, node.fontSize * sy);
      }
      return { nodeId, patch };
    })
    .filter((update): update is LeafUpdate => update !== null);
}

/** Translate the selection's leaves by (dx, dy). */
export function translateLeafPatches(
  document: LogoDocument,
  nodeIds: readonly string[],
  dx: number,
  dy: number,
): LeafUpdate[] {
  if (dx === 0 && dy === 0) {
    return [];
  }
  return collectLeafNodeIds(document, nodeIds)
    .map((nodeId): LeafUpdate | null => {
      const node = document.nodes[nodeId];
      if (!node || node.locked) {
        return null;
      }
      return { nodeId, patch: { x: node.x + dx, y: node.y + dy } };
    })
    .filter((update): update is LeafUpdate => update !== null);
}
