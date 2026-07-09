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
  /** Per-stop opacity 0–1; treated as 1 when absent. */
  alpha?: number;
};

export type LinearGradientPaint = {
  type: "linear-gradient";
  /** Direction in degrees; 0 = left→right. */
  angle: number;
  stops: GradientStop[];
  /**
   * Explicit endpoints, normalized to the node's box (0–1 like SVG
   * objectBoundingBox). Set by the on-canvas annotator; when absent the
   * line is derived from `angle` through the box centre (legacy docs).
   */
  start?: { x: number; y: number };
  end?: { x: number; y: number };
};

export type RadialGradientPaint = {
  type: "radial-gradient";
  /** Centre, normalized to the node's box (0–1). */
  cx: number;
  cy: number;
  /**
   * Radius as a fraction of the box (SVG objectBoundingBox semantics:
   * the unit circle is stretched by the box, so non-square nodes get an
   * elliptical falloff — matching the SVG export exactly).
   */
  r: number;
  /** Optional focal point, normalized; makes the falloff off-centre. */
  fx?: number;
  fy?: number;
  stops: GradientStop[];
};

export type Paint = SolidPaint | LinearGradientPaint | RadialGradientPaint;

export type Stroke = {
  color: string;
  width: number;
  /** Stroke alignment relative to path. */
  align: "center" | "inside" | "outside";
  /**
   * Optional gradient paint; when present it overrides `color` (which is
   * kept as the solid fallback so legacy readers stay correct).
   */
  paint?: Paint;
};

export type DropShadowEffect = {
  type: "drop-shadow";
  enabled: boolean;
  dx: number;
  dy: number;
  blur: number;
  color: string;
  opacity: number;
};

/** Outer stroke: the node's silhouette dilated and tinted, drawn behind. */
export type OutlineEffect = {
  type: "outline";
  enabled: boolean;
  width: number;
  color: string;
  opacity: number;
};

/**
 * Emboss approximation: two blurred silhouette copies clipped inside the
 * node's alpha — a light one offset toward the top-left and a dark one
 * toward the bottom-right (fixed diagonal light). No real lighting model.
 */
export type BevelEffect = {
  type: "bevel";
  enabled: boolean;
  /** Offset of the highlight/shade copies, px. */
  size: number;
  /** Blur applied to both copies, px. */
  soften: number;
  /** Strength of the highlight/shade, 0–1. */
  intensity: number;
};

export type GlowEffect = {
  type: "glow";
  enabled: boolean;
  blur: number;
  color: string;
  opacity: number;
};

export type Effect =
  | DropShadowEffect
  | OutlineEffect
  | BevelEffect
  | GlowEffect;

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
  /**
   * Layer-effect stack, drawn in array order: shadows/glows/outlines
   * render behind the node, bevels overlay inside its alpha. Disabled
   * entries stay in the stack but don't draw.
   */
  effects?: Effect[];
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

/**
 * Attachment of a text node to a path node ("type on a path"). While
 * present, glyphs are laid out along the referenced path — the text
 * node's own x/y is not used for layout (its box is only a selection
 * target, synced to the path on attach). Layout is derived at render
 * time, so moving/editing the path re-flows the text automatically.
 */
export type TextPathAttachment = {
  /** Id of the path node the text flows along. */
  pathId: string;
  /** Distance along the path where the first glyph starts, px. */
  startOffset: number;
  /**
   * Flip to the other side of the path: glyphs traverse the path from
   * its end and are rotated 180°, i.e. the layout you get by reversing
   * the path's direction.
   */
  flip: boolean;
};

export type FontStyle = "normal" | "italic";

export type TextNode = BaseNode & {
  type: "text";
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  /** Italic when set; upright when absent. */
  fontStyle?: FontStyle;
  letterSpacing: number;
  lineHeight: number;
  align: "left" | "center" | "right";
  /**
   * Manual per-pair kerning, Illustrator units (1/1000 em). Key `i`
   * adjusts the gap between content[i] and content[i+1]. Sparse: zero
   * entries are pruned; absent map = metrics kerning only.
   */
  kerning?: Record<number, number>;
  /**
   * OpenType feature toggles by tag ("liga", "dlig", "smcp", …).
   * Absent tags use the font's defaults.
   */
  otFeatures?: Record<string, boolean>;
  /** Present while the text is attached to a path. */
  onPath?: TextPathAttachment;
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
