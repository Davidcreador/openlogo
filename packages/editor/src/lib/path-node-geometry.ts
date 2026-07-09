import {
  type NodePatch,
  type PathGeometry,
  pathGeometryBounds,
  pathGeometryToSvg,
  translatePathGeometry,
} from "@openlogo/core";

/**
 * Node patch for a path whose artboard-local geometry changed: the
 * geometry renormalises to its own bounds, which become the node's box
 * and intrinsic space. Shared by bezier editing, scissors and join.
 */
export function patchFromLocalGeometry(geometry: PathGeometry): NodePatch | null {
  const bounds = pathGeometryBounds(geometry);
  if (!bounds) {
    return null;
  }

  const normalized = translatePathGeometry(geometry, -bounds.x, -bounds.y);
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    intrinsicWidth: bounds.width,
    intrinsicHeight: bounds.height,
    d: pathGeometryToSvg(normalized),
    geometry: normalized,
    // A geometry edit detaches a shape-library node from its params.
    shape: undefined,
  };
}
