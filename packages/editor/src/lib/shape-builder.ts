import type { Path } from "canvaskit-wasm";
import {
  type Bounds,
  type LogoDocument,
  type PathFillRule,
  type PathNode,
  type Vec2,
  collectLeafNodeIds,
  createId,
  expandDeletionSet,
  getActiveArtboard,
} from "@openlogo/core";
import {
  type CombineResult,
  computeRegions,
  unionPathData,
} from "@openlogo/renderer";
import { documentStore } from "../state/document";
import { combinableNodes } from "./boolean-ops";
import { getCanvasKit } from "./canvaskit";

/** Region count is 2^n − 1; eight operands keeps that comfortably small. */
export const SHAPE_BUILDER_MAX_NODES = 8;

export type ShapeBuilderRegion = {
  id: number;
  /** Path data, artboard-local (matches renderer overlay + hit-testing). */
  d: string;
  fillRule: PathFillRule;
  bounds: Bounds;
  /** Operand indices covering this region, back-to-front. */
  sources: number[];
  /** Live CanvasKit path for hit-testing. Owned by the session. */
  path: Path;
  state: "pending" | "merged" | "deleted";
  /** Click order; the first-clicked region styles the merged result. */
  mergeOrder: number;
};

export type ShapeBuilderSession = {
  /** Operand leaf node ids, scene z-order (back to front). */
  nodeIds: string[];
  /**
   * Document snapshot the regions were computed from. Regions freeze the
   * operands' geometry, so any commit against a different document would
   * apply stale shapes — callers cancel the session when this drifts.
   */
  document: LogoDocument;
  regions: ShapeBuilderRegion[];
  hoveredId: number | null;
  nextMergeOrder: number;
};

/**
 * Decompose the selection into Shape Builder regions. Returns null when
 * the tool cannot run (needs 2–8 fill-able shapes; text excluded).
 */
export async function createShapeBuilderSession(
  selectedNodeIds: readonly string[],
): Promise<ShapeBuilderSession | null> {
  const document = documentStore.document;
  const nodes = combinableNodes(selectedNodeIds);
  if (nodes.length < 2 || nodes.length > SHAPE_BUILDER_MAX_NODES) {
    return null;
  }

  const ck = await getCanvasKit();
  const regions = computeRegions(ck, nodes);
  const built: ShapeBuilderRegion[] = [];
  for (const [index, region] of regions.entries()) {
    const path = ck.Path.MakeFromSVGString(region.d);
    if (path) {
      path.setFillType(
        region.fillRule === "evenodd"
          ? ck.FillType.EvenOdd
          : ck.FillType.Winding,
      );
      built.push({
        id: index,
        d: region.d,
        fillRule: region.fillRule,
        bounds: region.bounds,
        sources: region.sources,
        path,
        state: "pending",
        mergeOrder: -1,
      });
    }
  }

  if (built.length < 2) {
    for (const region of built) {
      region.path.delete();
    }
    return null;
  }

  return {
    nodeIds: nodes.map((node) => node.id),
    document,
    regions: built,
    hoveredId: null,
    nextMergeOrder: 0,
  };
}

export function disposeShapeBuilderSession(
  session: ShapeBuilderSession,
): void {
  for (const region of session.regions) {
    region.path.delete();
  }
  session.regions = [];
}

/** Region under an artboard-local point (regions are disjoint). */
export function hitShapeBuilderRegion(
  session: ShapeBuilderSession,
  local: Vec2,
): ShapeBuilderRegion | null {
  return (
    session.regions.find((region) => region.path.contains(local.x, local.y)) ??
    null
  );
}

/**
 * Apply the session as one batch command: merged regions union into a
 * single path (styled from the first-clicked region's topmost source),
 * untouched regions survive as separate paths keeping their topmost
 * source's fill, deleted regions vanish, and the original operands are
 * removed. Returns the new node ids to select, or null when nothing was
 * merged or deleted (treat as cancel).
 */
export async function commitShapeBuilder(
  session: ShapeBuilderSession,
): Promise<string[] | null> {
  const document = documentStore.document;
  // Stale session (document changed underneath — regions no longer match
  // the operands' geometry): bail out safely, treated as a cancel.
  if (
    document !== session.document ||
    session.nodeIds.some((id) => !document.nodes[id])
  ) {
    return null;
  }

  const merged = session.regions
    .filter((region) => region.state === "merged")
    .sort((a, b) => a.mergeOrder - b.mergeOrder);
  const hasDeleted = session.regions.some(
    (region) => region.state === "deleted",
  );
  if (merged.length === 0 && !hasDeleted) {
    return null;
  }

  const ck = await getCanvasKit();
  const artboard = getActiveArtboard(document);

  // Topmost operand covering a region donates its style (fills only).
  const styleSource = (region: ShapeBuilderRegion) =>
    document.nodes[session.nodeIds[Math.max(...region.sources)]!]!;

  const makeNode = (
    result: CombineResult,
    region: ShapeBuilderRegion,
    name: string,
  ): PathNode => {
    const source = styleSource(region);
    return {
      id: createId("node"),
      type: "path",
      name,
      x: result.x,
      y: result.y,
      width: result.width,
      height: result.height,
      rotation: 0,
      opacity: source.opacity,
      visible: true,
      locked: false,
      fill: structuredClone(source.fill),
      d: result.d,
      fillRule: result.fillRule,
      geometry: result.geometry,
      intrinsicWidth: result.width,
      intrinsicHeight: result.height,
    };
  };

  // Untouched regions keep a stable stacking order (topmost source
  // last); the merged result goes on top — it is what the user built.
  const newNodes: PathNode[] = [];
  const pending = session.regions
    .filter((region) => region.state === "pending")
    .sort((a, b) => Math.max(...a.sources) - Math.max(...b.sources));
  for (const region of pending) {
    const result = unionPathData(ck, [
      { d: region.d, fillRule: region.fillRule },
    ]);
    if (result) {
      newNodes.push(makeNode(result, region, styleSource(region).name));
    }
  }
  if (merged.length > 0) {
    const result = unionPathData(
      ck,
      merged.map((region) => ({
        d: region.d,
        fillRule: region.fillRule,
      })),
    );
    if (result) {
      newNodes.push(makeNode(result, merged[0]!, "Shape Builder"));
    }
  }

  // Same placement rule as boolean ops: originals (and any groups the
  // deletion empties) go away; results land where the bottom-most
  // operand's top-level unit sat.
  const removedIds = new Set(expandDeletionSet(document, session.nodeIds));
  const firstTopIndex = artboard.nodeIds.findIndex(
    (id) =>
      removedIds.has(id) ||
      collectLeafNodeIds(document, [id]).some((leafId) =>
        removedIds.has(leafId),
      ),
  );
  const insertIndex = artboard.nodeIds
    .slice(0, Math.max(0, firstTopIndex))
    .filter((id) => !removedIds.has(id)).length;

  documentStore.apply({
    type: "batch",
    label: "Shape Builder",
    commands: [
      { type: "delete-nodes", nodeIds: [...removedIds] },
      ...(newNodes.length > 0
        ? [
            {
              type: "insert-nodes" as const,
              artboardId: artboard.id,
              nodes: newNodes,
              index: insertIndex,
            },
          ]
        : []),
    ],
  });

  return newNodes.map((node) => node.id);
}
