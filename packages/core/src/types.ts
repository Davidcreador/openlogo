/**
 * OpenLogo document model.
 *
 * Design constraints:
 * - Plain serializable data everywhere (JSON round-trip safe). No classes in
 *   the document itself so ops stay collab/CRDT-friendly later.
 * - Flat node table + per-artboard id ordering (z-order = array order).
 * - All mutations flow through commands (see commands.ts); nothing mutates
 *   a document in place.
 */

import type { PathGeometry } from "./path-data";

export type LogoVariant =
  | "primary"
  | "icon"
  | "wordmark"
  | "horizontal"
  | "stacked";

export type SolidPaint = {
  type: "solid";
  color: string;
};

export type GradientStop = {
  offset: number;
  color: string;
};

export type LinearGradientPaint = {
  type: "linear-gradient";
  /** Direction in degrees; 0 = left→right. */
  angle: number;
  stops: GradientStop[];
};

export type Paint = SolidPaint | LinearGradientPaint;

export type Stroke = {
  color: string;
  width: number;
  /** Stroke alignment relative to path. */
  align: "center" | "inside" | "outside";
};

export type BaseNode = {
  id: string;
  name: string;
  /** Position of the untransformed bounding box, artboard space. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotation in degrees around the box centre. */
  rotation: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  fill: Paint;
  stroke?: Stroke;
  /** Compositing mode; normal when absent. */
  blendMode?: BlendMode;
};

export type BlendMode =
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten";

export type RectangleNode = BaseNode & {
  type: "rectangle";
  cornerRadius: number;
};

export type EllipseNode = BaseNode & {
  type: "ellipse";
};

export type ShapeKind = "triangle" | "polygon" | "star" | "line" | "arrow";

/**
 * Parameters of a parametric shape-library node. Geometry is regenerated
 * from these (see shapes.ts); a bezier edit detaches the path from its
 * params — the editor clears `shape` when committing a path edit.
 */
export type ShapeParams = {
  kind: ShapeKind;
  /** Polygon side count / star point count. */
  sides?: number;
  /** Star inner radius as a fraction of the outer radius (0–1). */
  innerRatio?: number;
};

export type PathNode = BaseNode & {
  type: "path";
  /** SVG path data in the node's intrinsic coordinate space. */
  d: string;
  /** Intrinsic coordinate space the path data is authored in. */
  intrinsicWidth: number;
  intrinsicHeight: number;
  /**
   * Structured editable geometry (pen tool). Same intrinsic space as `d`,
   * which is derived from it. Absent on imported/legacy paths.
   */
  geometry?: PathGeometry;
  /** Present on shape-library nodes; drives param editing in the inspector. */
  shape?: ShapeParams;
};

export type TextNode = BaseNode & {
  type: "text";
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  letterSpacing: number;
  lineHeight: number;
  align: "left" | "center" | "right";
};

/**
 * Real scene-graph group. Children are node ids ordered back-to-front
 * within the group; the ids live in `document.nodes` but NOT in
 * `artboard.nodeIds` (only top-level ids do). A group's own
 * x/y/width/height/rotation/fill are unused placeholders — group
 * geometry is always derived from its children via `unitBounds` in
 * queries.ts, so it can never go stale. Transforms on a group cascade
 * to leaf nodes at commit time. `visible`/`locked`/`opacity` DO apply
 * and cascade down the subtree.
 */
export type GroupNode = BaseNode & {
  type: "group";
  children: string[];
};

export type LogoNode =
  | RectangleNode
  | EllipseNode
  | PathNode
  | TextNode
  | GroupNode;
export type NodeType = LogoNode["type"];

export type Artboard = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  background: string;
  purpose: LogoVariant;
  /** z-order, back to front. */
  nodeIds: string[];
  /** Ruler guides in artboard-local coordinates. */
  guides?: {
    /** Vertical guide x positions. */
    v: number[];
    /** Horizontal guide y positions. */
    h: number[];
  };
};

export type ColorPalette = {
  id: string;
  name: string;
  colors: string[];
};

export const DOCUMENT_SCHEMA_VERSION = 2;

export type LogoDocument = {
  schemaVersion: number;
  id: string;
  name: string;
  activeArtboardId: string;
  artboards: Artboard[];
  nodes: Record<string, LogoNode>;
  palettes: ColorPalette[];
};
