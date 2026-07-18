import type {
  Canvas,
  CanvasKit,
  ContourMeasure,
  EmbindEnumEntity,
  ImageFilter,
  Paint as SkPaint,
  Paragraph,
  Path,
  Surface,
  TextStyle,
} from "canvaskit-wasm";
import type {
  Artboard,
  Bounds,
  Effect,
  LogoDocument,
  LogoNode,
  MeasureSegment,
  Paint,
  PathFillRule,
  PathGeometry,
  PathPoint,
  SnapGuide,
  TextNode,
  Vec2,
} from "@openlogo/core";
import {
  type SelectionFrame,
  getAncestorGroupIds,
  getRenderNodesForArtboard,
  isGradient,
  kernAt,
  kernToPx,
  linearGradientPoints,
  normalizeTextPathContent,
  pathGeometryToSvg,
  rotatePoint,
  selectionFrame,
  selectionFrameCenter,
  setTextLayoutBounds,
  unitBounds,
} from "@openlogo/core";
import type { Camera } from "./camera";
import { screenToWorld } from "./camera";
import { FontRegistry } from "./fonts";
import { InvalidationScheduler } from "./invalidation-scheduler";
import { nodeToSkPath } from "./booleans";

export type Scene = {
  document: LogoDocument;
  camera: Camera;
  selectedNodeIds: readonly string[];
  /** Align key object within a multi-selection; drawn with an accent ring. */
  keyObjectId?: string | null;
  /** Node under the cursor (select tool, not selected, not dragging). */
  hoveredNodeId?: string | null;
  /** Node temporarily not drawn (e.g. behind an inline text editor). */
  hiddenNodeId?: string | null;
  /** Marquee rectangle in world space while drag-selecting. */
  marquee?: Bounds | null;
  /** Smart guides in active-artboard-local space while dragging. */
  guides?: readonly SnapGuide[] | null;
  /** Distance/spacing readouts in active-artboard-local space. */
  measurements?: {
    /** Pixel-distance readouts to nearby edges (line + label). */
    labels: readonly MeasureSegment[];
    /** Equal-spacing gap indicators (paired bars + labels). */
    spacing: readonly MeasureSegment[];
  } | null;
  /** In-progress pen drawing, artboard-local coordinates. */
  penPreview?: {
    points: readonly PathPoint[];
    cursor: Vec2 | null;
  } | null;
  /** Bezier node editing overlay, artboard-local coordinates. */
  pathEdit?: {
    geometry: PathGeometry;
    selected?: ReadonlyArray<{ subpath: number; index: number }> | null;
  } | null;
  /** Shape Builder overlay regions, artboard-local coordinates. */
  shapeBuilder?: {
    regions: ReadonlyArray<{
      d: string;
      fillRule: PathFillRule;
      state: "pending" | "merged" | "deleted";
      hovered: boolean;
    }>;
  } | null;
  /** Illustrator-style pixel grid over the active artboard. */
  showGrid?: boolean;
  /** Grid cell size in artboard px. */
  gridSize?: number;
};

export type TextMetrics = { width: number; height: number };

/**
 * Chrome-matched colors the GPU canvas cannot take from CSS custom
 * properties. Values mirror styles.css: selection follows --color-accent,
 * shadow/label strength is tuned per worksurface. setTheme() swaps the
 * whole object, so hot paths read plain properties — no per-frame branches.
 */
export type RendererThemeName = "dark" | "light";

type RendererTheme = {
  selection: string;
  artboardShadow: string;
  artboardShadowAlpha: number;
  artboardLabel: string;
};

const RENDERER_THEMES: Record<RendererThemeName, RendererTheme> = {
  dark: {
    selection: "#7c5cff",
    artboardShadow: "#000000",
    artboardShadowAlpha: 0.45,
    artboardLabel: "#8a8598",
  },
  light: {
    selection: "#4f6bf6",
    artboardShadow: "#1c1921",
    artboardShadowAlpha: 0.1,
    artboardLabel: "#5d5966",
  },
};

let activeTheme: RendererTheme = RENDERER_THEMES.dark;

const GUIDE_COLOR = "#ec4899";
const RULER_GUIDE_COLOR = "#06b6d4";

type ParagraphCacheEntry = {
  key: string;
  paragraph: Paragraph;
};

/** One placed glyph of a text-on-path layout (artboard-local baseline). */
export type TextPathGlyph = {
  /** Centre of the glyph advance on the path. */
  x: number;
  y: number;
  /** Baseline direction at the glyph, degrees. */
  angle: number;
  /** Baseline origin after arc placement. */
  originX: number;
  originY: number;
  advance: number;
  /** Vertical glyph-run bounds relative to the baseline. */
  top: number;
  bottom: number;
};

function textPathGlyphPoint(
  glyph: TextPathGlyph,
  along: number,
  vertical: number,
): Vec2 {
  const radians = (glyph.angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: glyph.originX + cos * along - sin * vertical,
    y: glyph.originY + sin * along + cos * vertical,
  };
}

/** AABB of the actual placed glyph run, used by selection and gradients. */
export function textPathLayoutBounds(
  layout: readonly TextPathGlyph[],
): Bounds | null {
  if (layout.length === 0) {
    return null;
  }
  const points = layout.flatMap((glyph) => [
    textPathGlyphPoint(glyph, 0, glyph.top),
    textPathGlyphPoint(glyph, glyph.advance, glyph.top),
    textPathGlyphPoint(glyph, glyph.advance, glyph.bottom),
    textPathGlyphPoint(glyph, 0, glyph.bottom),
  ]);
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function textPathGlyphContains(glyph: TextPathGlyph, point: Vec2): boolean {
  const radians = (-glyph.angle * Math.PI) / 180;
  const dx = point.x - glyph.originX;
  const dy = point.y - glyph.originY;
  const along = dx * Math.cos(radians) - dy * Math.sin(radians);
  const vertical = dx * Math.sin(radians) + dy * Math.cos(radians);
  return (
    along >= 0 &&
    along <= glyph.advance &&
    vertical >= glyph.top &&
    vertical <= glyph.bottom
  );
}

function roundedRectContains(point: Vec2, bounds: Bounds, radius: number): boolean {
  if (
    point.x < bounds.x ||
    point.x > bounds.x + bounds.width ||
    point.y < bounds.y ||
    point.y > bounds.y + bounds.height
  ) {
    return false;
  }
  const r = Math.max(0, Math.min(radius, bounds.width / 2, bounds.height / 2));
  if (r === 0) {
    return true;
  }
  const nearestX = Math.max(
    bounds.x + r,
    Math.min(point.x, bounds.x + bounds.width - r),
  );
  const nearestY = Math.max(
    bounds.y + r,
    Math.min(point.y, bounds.y + bounds.height - r),
  );
  const dx = point.x - nearestX;
  const dy = point.y - nearestY;
  return dx * dx + dy * dy <= r * r;
}

function rotateBoundsAround(bounds: Bounds, pivot: Vec2, degrees: number): Bounds {
  if (degrees % 360 === 0) {
    return bounds;
  }
  const corners = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ].map((point) => rotatePoint(point, pivot, degrees));
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

/** CSS-ish blur radius → Skia gaussian sigma. */
function blurSigma(blur: number): number {
  return blur / 2;
}

type ClippingPathNode = Extract<
  LogoNode,
  { type: "rectangle" | "ellipse" | "path" }
>;

/** Pure ancestor traversal shared by CanvasKit hit-testing and regression tests. */
export function pointInsideClippingMasks(
  document: LogoDocument,
  nodeId: string,
  point: Vec2,
  contains: (mask: ClippingPathNode, point: Vec2) => boolean,
): boolean {
  for (const groupId of getAncestorGroupIds(document, nodeId)) {
    const group = document.nodes[groupId];
    if (group?.type !== "group" || !group.clippingMaskId) {
      continue;
    }
    const mask = document.nodes[group.clippingMaskId];
    if (
      !mask ||
      mask.type === "group" ||
      mask.type === "text" ||
      !contains(mask, point)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Draws a LogoDocument to a canvas via CanvasKit and answers hit-tests.
 * Owns frame invalidation: callers mutate the scene then call `invalidate()`.
 */
export class SceneRenderer {
  private surface: Surface | null = null;
  private disposed = false;
  private scene: Scene | null = null;
  private dpr = 1;
  private readonly frameScheduler: InvalidationScheduler;
  private pathCache = new Map<string, Path>();
  private clipPathCache = new Map<string, { key: string; path: Path }>();
  private paragraphCache = new Map<string, ParagraphCacheEntry>();
  /** Stroked-glyph paragraphs for text nodes with a stroke. */
  private strokeParagraphCache = new Map<string, ParagraphCacheEntry>();
  /** Opaque glyph-alpha paragraphs used to mask aligned text strokes. */
  private maskParagraphCache = new Map<string, ParagraphCacheEntry>();
  /** Last computed text-on-path layout per text node (debug/automation). */
  private textPathLayouts = new Map<string, TextPathGlyph[]>();
  /** Live AABBs derived from those placed glyph runs. */
  private textPathBounds = new Map<string, Bounds>();
  /** Rendered paragraph or path-text AABBs used by interaction queries. */
  private textInteractionBounds = new Map<string, Bounds>();

  /** Floating artboard name labels, keyed by artboard id. */
  private labelCache = new Map<string, ParagraphCacheEntry>();

  /**
   * World-space rects of the artboard labels drawn last frame, for
   * pointer hit-testing (click activates, drag repositions the board).
   * Culled boards carry no rect — their labels are offscreen anyway.
   */
  private labelRects = new Map<string, Bounds>();
  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.releaseSurface();
    this.clearRenderCaches();
  };
  private readonly onContextRestored = () => {
    if (!this.disposed && this.recover()) {
      this.invalidate();
    }
  };

  constructor(
    private readonly canvasKit: CanvasKit,
    private readonly canvas: HTMLCanvasElement,
    readonly fonts: FontRegistry,
    private readonly onTextMetrics?: (nodeId: string, metrics: TextMetrics) => void,
  ) {
    this.frameScheduler = new InvalidationScheduler(() => {
      const scene = this.scene;
      if (!scene || (!this.surface && !this.createSurface(false))) {
        return;
      }
      try {
        this.draw(scene);
      } catch (error) {
        // A driver may report context loss only when flush/draw is attempted.
        // Drop the unusable surface; the restore event or next invalidation
        // will rebuild it without losing the document.
        console.warn("CanvasKit render surface failed; awaiting recovery.", error);
        this.releaseSurface();
        this.clearRenderCaches();
      }
    });
    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    try {
      this.createSurface(true);
    } catch (error) {
      this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
      this.canvas.removeEventListener(
        "webglcontextrestored",
        this.onContextRestored,
      );
      this.frameScheduler.dispose();
      throw error;
    }
  }

  setScene(scene: Scene): void {
    const documentChanged = this.scene?.document !== scene.document;
    this.scene = scene;
    if (documentChanged) {
      // Evict paragraphs whose text node no longer exists — the cache is
      // keyed by node id and would otherwise grow for the whole session.
      for (const cache of [
        this.paragraphCache,
        this.strokeParagraphCache,
        this.maskParagraphCache,
      ]) {
        for (const [nodeId, entry] of cache) {
          if (!scene.document.nodes[nodeId]) {
            entry.paragraph.delete();
            cache.delete(nodeId);
          }
        }
      }
      for (const nodeId of this.textPathLayouts.keys()) {
        if (!scene.document.nodes[nodeId]) {
          this.textPathLayouts.delete(nodeId);
          this.textPathBounds.delete(nodeId);
        }
      }
      for (const nodeId of this.textInteractionBounds.keys()) {
        if (!scene.document.nodes[nodeId]) {
          this.textInteractionBounds.delete(nodeId);
        }
      }
      const clippingMaskIds = new Set(
        Object.values(scene.document.nodes)
          .filter(
            (node): node is Extract<LogoNode, { type: "group" }> =>
              node.type === "group" && node.clippingMaskId !== undefined,
          )
          .map((node) => node.clippingMaskId!),
      );
      for (const [nodeId, entry] of this.clipPathCache) {
        if (!clippingMaskIds.has(nodeId)) {
          entry.path.delete();
          this.clipPathCache.delete(nodeId);
        }
      }
      const artboardIds = new Set(
        scene.document.artboards.map((item) => item.id),
      );
      for (const [artboardId, entry] of this.labelCache) {
        if (!artboardIds.has(artboardId)) {
          entry.paragraph.delete();
          this.labelCache.delete(artboardId);
          this.labelRects.delete(artboardId);
        }
      }
    }
    this.invalidate();
  }

  invalidate(): void {
    this.frameScheduler.invalidate();
  }

  /** Drop paragraphs bound to old provider faces, then repaint. */
  invalidateFonts(): void {
    this.clearFontCaches();
    this.invalidate();
  }

  /**
   * Swap the theme-tied constants (module-wide — every renderer shares the
   * app theme) and repaint. Artboard labels bake their color into cached
   * paragraphs, so the label cache is dropped with it.
   */
  setTheme(name: RendererThemeName): void {
    if (activeTheme === RENDERER_THEMES[name]) {
      return;
    }
    activeTheme = RENDERER_THEMES[name];
    for (const entry of this.labelCache.values()) {
      entry.paragraph.delete();
    }
    this.labelCache.clear();
    this.invalidate();
  }

  /** Recreate a missing surface after WebGL context loss. */
  recover(): boolean {
    if (this.disposed) {
      return false;
    }
    return Boolean(this.surface) || this.createSurface(false);
  }

  /** Resize backing store to CSS size * devicePixelRatio. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (this.disposed) {
      return;
    }
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.createSurface(false);
    this.invalidate();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.frameScheduler.dispose();
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener(
      "webglcontextrestored",
      this.onContextRestored,
    );
    this.clearRenderCaches();
    this.releaseSurface();
  }

  /**
   * Topmost visible, unlocked LEAF node at a screen point, or null.
   * Groups never hit directly — callers resolve the leaf to a group
   * selection unit via the editor's active-group scope.
   */
  hitTest(screenPoint: Vec2): LogoNode | null {
    if (!this.scene) {
      return null;
    }

    const { document, camera } = this.scene;
    const artboard = document.artboards.find(
      (item) => item.id === document.activeArtboardId,
    );
    if (!artboard) {
      return null;
    }

    // Node coordinates are artboard-local; pointer arrives in screen space.
    const world = screenToWorld(camera, screenPoint);
    const local = { x: world.x - artboard.x, y: world.y - artboard.y };
    const nodes = getRenderNodesForArtboard(document);

    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i];
      if (!node || !node.visible || node.locked) {
        continue;
      }
      if (
        this.nodeContains(node, local) &&
        this.pointInsideClippingAncestors(document, node.id, local)
      ) {
        return node;
      }
    }

    return null;
  }

  /** A clipped child is never interactive outside every owning mask. */
  private pointInsideClippingAncestors(
    document: LogoDocument,
    nodeId: string,
    point: Vec2,
  ): boolean {
    return pointInsideClippingMasks(
      document,
      nodeId,
      point,
      (mask, candidate) => {
        const path = this.getClippingPath(mask);
        return path?.contains(candidate.x, candidate.y) ?? false;
      },
    );
  }

  private nodeContains(node: LogoNode, worldPoint: Vec2): boolean {
    if (node.type === "group") {
      return false; // hit-testing walks leaves only
    }

    if (node.type === "text" && node.onPath) {
      const layout = this.textPathLayouts.get(node.id);
      return layout?.some((glyph) => textPathGlyphContains(glyph, worldPoint)) ?? false;
    }

    if (node.type === "text") {
      const bounds = this.textInteractionBounds.get(node.id);
      if (bounds) {
        const outset = node.stroke
          ? node.stroke.width *
            (node.stroke.align === "outside"
              ? 1
              : node.stroke.align === "center"
                ? 0.5
                : 0)
          : 0;
        return (
          worldPoint.x >= bounds.x - outset &&
          worldPoint.x <= bounds.x + bounds.width + outset &&
          worldPoint.y >= bounds.y - outset &&
          worldPoint.y <= bounds.y + bounds.height + outset
        );
      }
    }

    // Undo the node's rotation, then test in its local axis-aligned space.
    const center = {
      x: node.x + node.width / 2,
      y: node.y + node.height / 2,
    };
    const local = rotatePoint(worldPoint, center, -node.rotation);
    const strokeOutset = node.stroke
      ? node.stroke.width *
        (node.stroke.align === "outside"
          ? 1
          : node.stroke.align === "center"
            ? 0.5
            : 0)
      : 0;
    const scale =
      node.type === "path"
        ? Math.max(
            Math.abs(node.width / node.intrinsicWidth),
            Math.abs(node.height / node.intrinsicHeight),
          )
        : 1;
    const boxOutset = strokeOutset * (Number.isFinite(scale) ? scale : 1);
    const hitTolerance = node.type === "path" && node.stroke ? 6 : 0;
    const coarseOutset = boxOutset + hitTolerance;
    const inBox =
      local.x >= node.x - coarseOutset &&
      local.x <= node.x + node.width + coarseOutset &&
      local.y >= node.y - coarseOutset &&
      local.y <= node.y + node.height + coarseOutset;

    if (!inBox) {
      return false;
    }

    if (node.type === "ellipse") {
      const dx = (local.x - center.x) / (node.width / 2 + boxOutset);
      const dy = (local.y - center.y) / (node.height / 2 + boxOutset);
      return dx * dx + dy * dy <= 1;
    }

    if (node.type === "rectangle") {
      return roundedRectContains(
        local,
        {
          x: node.x - boxOutset,
          y: node.y - boxOutset,
          width: node.width + boxOutset * 2,
          height: node.height + boxOutset * 2,
        },
        node.cornerRadius + boxOutset,
      );
    }

    if (node.type === "path") {
      const path = this.getPath(node.d, node.fillRule);
      if (!path) {
        return false;
      }
      const intrinsicX =
        ((local.x - node.x) / node.width) * node.intrinsicWidth;
      const intrinsicY =
        ((local.y - node.y) / node.height) * node.intrinsicHeight;
      if (path.contains(intrinsicX, intrinsicY)) {
        return true;
      }
      // Stroked open paths (line shapes) have no fill area — hit against
      // the stroke outline with a small tolerance instead.
      if (node.stroke && node.stroke.width > 0) {
        const stroked = path.copy();
        const alignedWidth =
          node.stroke.align === "center"
            ? node.stroke.width
            : node.stroke.width * 2;
        const scaleX = Math.abs(node.width / node.intrinsicWidth);
        const scaleY = Math.abs(node.height / node.intrinsicHeight);
        const minScale = Math.min(scaleX, scaleY);
        const toleranceWidth =
          Number.isFinite(minScale) && minScale > 0 ? 6 / minScale : 6;
        const ok = stroked.stroke({
          width: Math.max(alignedWidth, toleranceWidth),
          cap: this.canvasKit.StrokeCap.Round,
          join: this.canvasKit.StrokeJoin.Round,
        });
        const hit = ok ? stroked.contains(intrinsicX, intrinsicY) : false;
        stroked.delete();
        return hit;
      }
      return false;
    }

    // Text without live paragraph metrics falls back to its stored box.
    return true;
  }

  private releaseSurface(): void {
    const surface = this.surface;
    this.surface = null;
    try {
      surface?.delete();
    } catch {
      // A lost WebGL context can invalidate the embind wrapper first.
    }
  }

  private clearRenderCaches(): void {
    for (const path of this.pathCache.values()) {
      try {
        path.delete();
      } catch {
        // Context loss may already have released the backing object.
      }
    }
    for (const entry of this.clipPathCache.values()) {
      try {
        entry.path.delete();
      } catch {
        // See above.
      }
    }
    this.pathCache.clear();
    this.clipPathCache.clear();
    this.clearFontCaches();
    this.textPathLayouts.clear();
    this.textPathBounds.clear();
    this.textInteractionBounds.clear();
  }

  private clearFontCaches(): void {
    for (const entry of [
      ...this.paragraphCache.values(),
      ...this.strokeParagraphCache.values(),
      ...this.maskParagraphCache.values(),
      ...this.labelCache.values(),
    ]) {
      try {
        entry.paragraph.delete();
      } catch {
        // Context loss may already have released the backing object.
      }
    }
    this.paragraphCache.clear();
    this.strokeParagraphCache.clear();
    this.maskParagraphCache.clear();
    this.labelCache.clear();
    this.labelRects.clear();
  }

  private createSurface(throwOnFailure: boolean): boolean {
    this.releaseSurface();
    try {
      this.surface = this.canvasKit.MakeWebGLCanvasSurface(this.canvas);
    } catch {
      this.surface = null;
    }
    if (!this.surface) {
      try {
        this.surface = this.canvasKit.MakeSWCanvasSurface(this.canvas);
      } catch {
        this.surface = null;
      }
    }
    if (!this.surface && throwOnFailure) {
      throw new Error("CanvasKit could not create a rendering surface.");
    }
    return this.surface !== null;
  }

  private draw(scene: Scene): void {
    const surface = this.surface;
    if (!surface) {
      return;
    }

    const ck = this.canvasKit;
    const canvas = surface.getCanvas();
    const { camera, document } = scene;

    // Transparent clear: the editor styles the worksurface (color + dot
    // grid) in CSS, so floating panels and canvas share one material.
    canvas.clear(ck.TRANSPARENT);
    canvas.save();
    canvas.scale(this.dpr * camera.zoom, this.dpr * camera.zoom);
    canvas.translate(-camera.offset.x, -camera.offset.y);

    // Every artboard lives on one shared canvas (Illustrator-style), but
    // only the ones intersecting the viewport draw: culling keeps frame
    // cost flat however many artboards the document holds.
    const viewLeft = camera.offset.x;
    const viewTop = camera.offset.y;
    const viewRight = viewLeft + this.canvas.width / (this.dpr * camera.zoom);
    const viewBottom = viewTop + this.canvas.height / (this.dpr * camera.zoom);
    // Covers the drop shadow bleed and the floating name label above.
    const margin = 48 / camera.zoom;

    this.labelRects.clear();
    for (const artboard of document.artboards) {
      const visible =
        artboard.x - margin < viewRight &&
        artboard.x + artboard.width + margin > viewLeft &&
        artboard.y - margin < viewBottom &&
        artboard.y + artboard.height + margin > viewTop;
      if (!visible) {
        continue;
      }
      this.drawArtboard(canvas, document, artboard, camera);
      this.drawArtboardChrome(
        canvas,
        artboard,
        camera,
        artboard.id === document.activeArtboardId,
      );
    }

    this.drawRulerGuides(canvas, scene);
    this.drawHover(canvas, scene);
    this.drawShapeBuilder(canvas, scene);
    this.drawSelection(canvas, scene);
    this.drawGuides(canvas, scene);
    this.drawMeasurements(canvas, scene);
    this.drawPenPreview(canvas, scene);
    this.drawPathEdit(canvas, scene);
    this.drawMarquee(canvas, scene);

    canvas.restore();
    surface.flush();
  }

  private drawArtboard(
    canvas: Canvas,
    document: LogoDocument,
    artboard: Artboard,
    camera: Camera,
  ): void {
    const ck = this.canvasKit;
    const rect = ck.XYWHRect(
      artboard.x,
      artboard.y,
      artboard.width,
      artboard.height,
    );

    // Drop shadow + background.
    const shadow = new ck.Paint();
    shadow.setColor(ck.parseColorString(activeTheme.artboardShadow));
    shadow.setAlphaf(activeTheme.artboardShadowAlpha);
    shadow.setMaskFilter(
      ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, 14 / camera.zoom, true),
    );
    canvas.drawRect(
      ck.XYWHRect(
        artboard.x,
        artboard.y + 5 / camera.zoom,
        artboard.width,
        artboard.height,
      ),
      shadow,
    );
    shadow.delete();

    const background = new ck.Paint();
    background.setColor(ck.parseColorString(artboard.background));
    canvas.drawRect(rect, background);
    background.delete();

    canvas.save();
    canvas.clipRect(rect, ck.ClipOp.Intersect, true);
    canvas.translate(artboard.x, artboard.y);

    if (
      this.scene?.showGrid &&
      artboard.id === document.activeArtboardId
    ) {
      this.drawArtboardGrid(
        canvas,
        artboard.width,
        artboard.height,
        this.scene.gridSize ?? 8,
        camera.zoom,
      );
    }

    // Tree walk instead of the flattened render list: a group with a
    // blend mode must composite its subtree as ONE layer against the
    // backdrop (saveLayer), which per-leaf flattening cannot express.
    // Opacity still cascades per-leaf, matching getRenderNodesForArtboard.
    for (const nodeId of artboard.nodeIds) {
      this.drawSubtree(canvas, document, nodeId, 1);
    }

    canvas.restore();
  }

  /** Square grid in artboard-local space (caller already translated). */
  private drawArtboardGrid(
    canvas: Canvas,
    width: number,
    height: number,
    gridSize: number,
    zoom: number,
  ): void {
    if (!Number.isFinite(gridSize) || gridSize <= 0) {
      return;
    }
    const ck = this.canvasKit;
    const paint = new ck.Paint();
    paint.setStyle(ck.PaintStyle.Stroke);
    paint.setStrokeWidth(1 / zoom);
    paint.setColor(ck.parseColorString(activeTheme.selection));
    paint.setAlphaf(0.18);
    paint.setAntiAlias(false);

    for (let x = gridSize; x < width; x += gridSize) {
      canvas.drawLine(x, 0, x, height, paint);
    }
    for (let y = gridSize; y < height; y += gridSize) {
      canvas.drawLine(0, y, width, y, paint);
    }
    paint.delete();
  }

  /**
   * Per-board chrome on the shared canvas: the floating name label above
   * the board (screen-constant size) and, on the active board, a subtle
   * accent outline. Records the label's world rect for hit-testing.
   */
  private drawArtboardChrome(
    canvas: Canvas,
    artboard: Artboard,
    camera: Camera,
    isActive: boolean,
  ): void {
    const ck = this.canvasKit;
    const zoom = camera.zoom;

    if (isActive) {
      const outline = new ck.Paint();
      outline.setStyle(ck.PaintStyle.Stroke);
      outline.setStrokeWidth(1.25 / zoom);
      outline.setColor(ck.parseColorString(activeTheme.selection));
      outline.setAlphaf(0.65);
      outline.setAntiAlias(true);
      canvas.drawRect(
        ck.XYWHRect(artboard.x, artboard.y, artboard.width, artboard.height),
        outline,
      );
      outline.delete();
    }

    const family = this.fonts.isEmpty
      ? null
      : this.fonts.resolveFamily("Inter, ui-sans-serif");
    if (!family) {
      return; // no fonts yet — board still clickable via its body
    }

    const fontSize = 11 / zoom;
    const key = `${artboard.name}|${fontSize}|${isActive ? 1 : 0}`;
    let entry = this.labelCache.get(artboard.id);
    if (!entry || entry.key !== key) {
      entry?.paragraph.delete();
      const style = new ck.ParagraphStyle({
        textAlign: ck.TextAlign.Left,
        maxLines: 1,
        ellipsis: "…",
        textStyle: {
          color: ck.parseColorString(
            isActive ? activeTheme.selection : activeTheme.artboardLabel,
          ),
          fontFamilies: [family],
          fontSize,
          fontStyle: { weight: { value: 550 } },
          fontVariations: [{ axis: "wght", value: 550 }],
        },
      });
      const builder = ck.ParagraphBuilder.MakeFromFontProvider(
        style,
        this.fonts.provider,
      );
      builder.addText(artboard.name);
      const paragraph = builder.build();
      // Labels never grow past their board (ellipsized), min 80px wide.
      paragraph.layout(Math.max(artboard.width, 80 / zoom));
      builder.delete();
      entry = { key, paragraph };
      this.labelCache.set(artboard.id, entry);
    }

    const textWidth = Math.min(
      entry.paragraph.getLongestLine(),
      Math.max(artboard.width, 80 / zoom),
    );
    const textHeight = entry.paragraph.getHeight();
    const labelX = artboard.x;
    const labelY = artboard.y - textHeight - 6 / zoom;
    canvas.drawParagraph(entry.paragraph, labelX, labelY);

    // Slightly padded hit rect so the label is comfortably grabbable.
    const pad = 4 / zoom;
    this.labelRects.set(artboard.id, {
      x: labelX - pad,
      y: labelY - pad,
      width: Math.max(textWidth, 24 / zoom) + pad * 2,
      height: textHeight + pad * 2,
    });
  }

  /**
   * Artboard whose floating name label contains the screen point (topmost
   * wins). Rects come from the last drawn frame.
   */
  hitArtboardLabel(screenPoint: Vec2): string | null {
    if (!this.scene) {
      return null;
    }
    const world = screenToWorld(this.scene.camera, screenPoint);
    let hit: string | null = null;
    for (const [artboardId, rect] of this.labelRects) {
      if (
        world.x >= rect.x &&
        world.x <= rect.x + rect.width &&
        world.y >= rect.y &&
        world.y <= rect.y + rect.height
      ) {
        hit = artboardId; // later boards draw on top
      }
    }
    return hit;
  }

  /** Topmost artboard whose canvas rect contains the screen point. */
  hitArtboardBody(screenPoint: Vec2): string | null {
    if (!this.scene) {
      return null;
    }
    const { document, camera } = this.scene;
    const world = screenToWorld(camera, screenPoint);
    for (let i = document.artboards.length - 1; i >= 0; i -= 1) {
      const artboard = document.artboards[i]!;
      if (
        world.x >= artboard.x &&
        world.x <= artboard.x + artboard.width &&
        world.y >= artboard.y &&
        world.y <= artboard.y + artboard.height
      ) {
        return artboard.id;
      }
    }
    return null;
  }

  private drawSubtree(
    canvas: Canvas,
    document: LogoDocument,
    nodeId: string,
    opacity: number,
  ): void {
    const node = document.nodes[nodeId];
    if (!node || !node.visible || node.id === this.scene?.hiddenNodeId) {
      return;
    }

    if (node.type === "group") {
      const effects = node.effects?.filter((effect) => effect.enabled) ?? [];
      const drawChildren = () => {
        const drawContent = () => {
          for (const childId of node.children) {
            if (childId !== node.clippingMaskId) {
              this.drawSubtree(
                canvas,
                document,
                childId,
                opacity * node.opacity,
              );
            }
          }
        };
        if (!node.clippingMaskId) {
          drawContent();
          return;
        }

        const mask = document.nodes[node.clippingMaskId];
        if (!mask || mask.type === "group" || mask.type === "text") {
          return; // malformed relationship fails closed, never leaks content
        }
        const clippingPath = this.getClippingPath(mask);
        if (!clippingPath) {
          return;
        }
        canvas.save();
        canvas.clipPath(
          clippingPath,
          this.canvasKit.ClipOp.Intersect,
          true,
        );
        drawContent();
        canvas.restore();
      };
      this.drawWithBlendMode(canvas, node.blendMode, () => {
        if (effects.length > 0) {
          this.drawWithEffects(canvas, effects, drawChildren);
        } else {
          drawChildren();
        }
      });
      return;
    }

    this.drawNode(
      canvas,
      opacity === 1
        ? node
        : ({ ...node, opacity: node.opacity * opacity } as LogoNode),
    );
  }

  private skBlendMode(mode: NonNullable<LogoNode["blendMode"]>) {
    const ck = this.canvasKit;
    return {
      multiply: ck.BlendMode.Multiply,
      screen: ck.BlendMode.Screen,
      overlay: ck.BlendMode.Overlay,
      darken: ck.BlendMode.Darken,
      lighten: ck.BlendMode.Lighten,
    }[mode];
  }

  /**
   * Blend the complete visual result as one compositing unit. Applying the
   * mode to an individual fill paint would omit strokes, effects and
   * paragraph text, and would let overlapping pieces blend independently.
   */
  private drawWithBlendMode(
    canvas: Canvas,
    blendMode: LogoNode["blendMode"],
    content: () => void,
  ): void {
    if (!blendMode) {
      content();
      return;
    }

    const layerPaint = new this.canvasKit.Paint();
    layerPaint.setBlendMode(this.skBlendMode(blendMode));
    canvas.saveLayer(layerPaint);
    content();
    canvas.restore();
    layerPaint.delete();
  }

  private drawNode(canvas: Canvas, node: LogoNode): void {
    if (node.type === "group") {
      return; // groups draw nothing themselves
    }

    const effects = node.effects?.filter((effect) => effect.enabled) ?? [];
    this.drawWithBlendMode(canvas, node.blendMode, () => {
      if (effects.length > 0) {
        this.drawWithEffects(canvas, effects, () => this.drawLeaf(canvas, node));
      } else {
        this.drawLeaf(canvas, node);
      }
    });
  }

  /**
   * Layer-effect orchestration around any draw callback. Shadows, glows
   * and outlines re-render the content into an offscreen layer whose
   * ImageFilter replaces it with the effect (DropShadowOnly / tinted
   * Dilate), drawn BEHIND the real content. Bevels approximate an emboss:
   * the content plus, clipped inside its alpha via SrcATop, a blurred
   * light copy offset toward the top-left and a dark copy toward the
   * bottom-right (fixed diagonal light — documented approximation, no
   * real lighting model).
   */
  private drawWithEffects(
    canvas: Canvas,
    effects: Effect[],
    content: () => void,
  ): void {
    const ck = this.canvasKit;

    const layerWithFilter = (filter: ImageFilter, blendMode?: EmbindEnumEntity) => {
      const paint = new ck.Paint();
      paint.setImageFilter(filter);
      if (blendMode) {
        paint.setBlendMode(blendMode);
      }
      canvas.saveLayer(paint);
      content();
      canvas.restore();
      paint.delete();
      filter.delete();
    };

    // Under-effects, in stack order, behind the content.
    for (const effect of effects) {
      if (effect.type === "drop-shadow" || effect.type === "glow") {
        const dx = effect.type === "drop-shadow" ? effect.dx : 0;
        const dy = effect.type === "drop-shadow" ? effect.dy : 0;
        const color = ck.parseColorString(effect.color);
        color[3] = (color[3] ?? 1) * effect.opacity;
        layerWithFilter(
          ck.ImageFilter.MakeDropShadowOnly(
            dx,
            dy,
            blurSigma(effect.blur),
            blurSigma(effect.blur),
            color,
            null,
          ),
        );
      } else if (effect.type === "outline" && effect.width > 0) {
        const color = ck.parseColorString(effect.color);
        color[3] = (color[3] ?? 1) * effect.opacity;
        const colorFilter = ck.ColorFilter.MakeBlend(color, ck.BlendMode.SrcIn);
        const tint = ck.ImageFilter.MakeColorFilter(colorFilter, null);
        layerWithFilter(ck.ImageFilter.MakeDilate(effect.width, effect.width, tint));
        tint.delete();
        colorFilter.delete();
      }
    }

    const bevels = effects.filter(
      (effect): effect is Extract<Effect, { type: "bevel" }> =>
        effect.type === "bevel",
    );
    if (bevels.length === 0) {
      content();
      return;
    }

    // Content + bevel overlays live in one layer so SrcATop clips the
    // overlays to the content's alpha only (not to shadows below).
    // Each bevel pass builds an edge RIM — the silhouette minus itself
    // shifted away from the light — then tints, blurs and composites it
    // inside the content: lit rim toward the top-left, shaded rim toward
    // the bottom-right.
    canvas.saveLayer();
    content();
    for (const bevel of bevels) {
      const passes: Array<{ sign: number; color: string }> = [
        { sign: -1, color: "#ffffff" },
        { sign: 1, color: "#000000" },
      ];
      for (const pass of passes) {
        const color = ck.parseColorString(pass.color);
        color[3] = bevel.intensity;
        const colorFilter = ck.ColorFilter.MakeBlend(color, ck.BlendMode.SrcIn);
        let filter = ck.ImageFilter.MakeColorFilter(colorFilter, null);
        const tint = filter;
        if (bevel.soften > 0) {
          filter = ck.ImageFilter.MakeBlur(
            blurSigma(bevel.soften),
            blurSigma(bevel.soften),
            ck.TileMode.Decal,
            filter,
          );
        }

        const rimPaint = new ck.Paint();
        rimPaint.setImageFilter(filter);
        rimPaint.setBlendMode(ck.BlendMode.SrcATop);
        canvas.saveLayer(rimPaint);
        content();
        // Erase the silhouette shifted away from the light; what's left
        // is the rim facing it.
        const erase = new ck.Paint();
        erase.setBlendMode(ck.BlendMode.DstOut);
        canvas.save();
        canvas.translate(-pass.sign * bevel.size, -pass.sign * bevel.size);
        canvas.saveLayer(erase);
        content();
        canvas.restore();
        canvas.restore();
        canvas.restore();

        erase.delete();
        rimPaint.delete();
        if (filter !== tint) {
          filter.delete();
        }
        tint.delete();
        colorFilter.delete();
      }
    }
    canvas.restore();
  }

  /**
   * Bounds gradients anchor to, in the coordinate space the node's
   * geometry is DRAWN in: intrinsic space for paths (drawLeaf scales the
   * canvas before drawPath), the artboard-space box for everything else.
   */
  private paintBox(node: LogoNode): Bounds {
    return node.type === "text" && this.textInteractionBounds.has(node.id)
      ? this.textInteractionBounds.get(node.id)!
      : node.type === "path"
      ? { x: 0, y: 0, width: node.intrinsicWidth, height: node.intrinsicHeight }
      : { x: node.x, y: node.y, width: node.width, height: node.height };
  }

  private drawLeaf(canvas: Canvas, node: LogoNode): void {
    if (node.type === "group") {
      return;
    }

    const ck = this.canvasKit;
    canvas.save();

    if (node.rotation !== 0) {
      canvas.rotate(
        node.rotation,
        node.x + node.width / 2,
        node.y + node.height / 2,
      );
    }

    const fill = this.makePaint(node.fill, this.paintBox(node), node.opacity);

    if (node.type === "rectangle") {
      const rrect = ck.RRectXY(
        ck.XYWHRect(node.x, node.y, node.width, node.height),
        node.cornerRadius,
        node.cornerRadius,
      );
      canvas.drawRRect(rrect, fill);
      this.strokeNode(
        canvas,
        node,
        (paint) => canvas.drawRRect(rrect, paint),
        (op) => canvas.clipRRect(rrect, op, true),
      );
    } else if (node.type === "ellipse") {
      const rect = ck.XYWHRect(node.x, node.y, node.width, node.height);
      canvas.drawOval(rect, fill);
      this.strokeNode(
        canvas,
        node,
        (paint) => canvas.drawOval(rect, paint),
        (op) => {
          const oval = new ck.Path();
          oval.addOval(rect);
          canvas.clipPath(oval, op, true);
          oval.delete();
        },
      );
    } else if (node.type === "path") {
      const path = this.getPath(node.d, node.fillRule);
      if (path) {
        canvas.save();
        canvas.translate(node.x, node.y);
        canvas.scale(
          node.width / node.intrinsicWidth,
          node.height / node.intrinsicHeight,
        );
        canvas.drawPath(path, fill);
        this.strokeNode(
          canvas,
          node,
          (paint) => canvas.drawPath(path, paint),
          (op) => canvas.clipPath(path, op, true),
        );
        canvas.restore();
      }
    } else if (node.type === "text") {
      this.drawText(canvas, node);
    }

    fill.delete();
    canvas.restore();
  }

  private strokeNode(
    canvas: Canvas,
    node: LogoNode,
    drawShape: (paint: SkPaint) => void,
    clipShape: (op: EmbindEnumEntity) => void,
  ): void {
    const paint = this.makeStrokePaint(node);
    if (!paint) {
      return;
    }
    if (node.stroke?.align === "center") {
      drawShape(paint);
    } else {
      canvas.save();
      clipShape(
        node.stroke?.align === "outside"
          ? this.canvasKit.ClipOp.Difference
          : this.canvasKit.ClipOp.Intersect,
      );
      drawShape(paint);
      canvas.restore();
    }
    paint.delete();
  }

  /**
   * Canvas paint for a node's stroke (center-aligned, like the shape
   * renderer draws it). Null when the node has no drawable stroke.
   */
  private makeStrokePaint(node: LogoNode): SkPaint | null {
    const stroke = node.stroke;
    if (!stroke || stroke.width <= 0) {
      return null;
    }

    const ck = this.canvasKit;
    // Gradient strokes ride the same shader path as fills.
    const paint =
      stroke.paint && isGradient(stroke.paint)
        ? this.makePaint(stroke.paint, this.paintBox(node), node.opacity)
        : new ck.Paint();
    paint.setStyle(ck.PaintStyle.Stroke);
    paint.setStrokeWidth(
      stroke.align === "center" ? stroke.width : stroke.width * 2,
    );
    if (!stroke.paint || !isGradient(stroke.paint)) {
      const color = ck.parseColorString(
        stroke.paint?.type === "solid" ? stroke.paint.color : stroke.color,
      );
      color[3] = (color[3] ?? 1) * node.opacity;
      paint.setColor(color);
    }
    paint.setAntiAlias(true);
    return paint;
  }

  private drawText(canvas: Canvas, node: TextNode): void {
    if (node.onPath && this.drawTextOnPath(canvas, node)) {
      return;
    }
    // Not on a path (or fell back): drop any stale layout so the probe
    // reflects what is actually drawn.
    this.textPathLayouts.delete(node.id);
    this.textPathBounds.delete(node.id);

    const paragraph = this.getParagraph(node);
    if (paragraph) {
      const width = paragraph.getLongestLine();
      const height = paragraph.getHeight();
      const x =
        node.align === "center"
          ? node.x + (node.width - width) / 2
          : node.align === "right"
            ? node.x + node.width - width
            : node.x;
      const bounds = rotateBoundsAround(
        { x, y: node.y, width, height },
        { x: node.x + node.width / 2, y: node.y + node.height / 2 },
        node.rotation,
      );
      this.textInteractionBounds.set(node.id, bounds);
      if (this.scene) {
        setTextLayoutBounds(this.scene.document, node.id, bounds);
      }
      if (Math.abs(node.height - height) >= 0.01) {
        this.onTextMetrics?.(node.id, { width, height });
      }
      if (isGradient(node.fill)) {
        // Skia's TextStyle has no shader slot, so gradient text renders
        // the glyphs opaque into a layer and stamps the gradient over
        // them with SrcIn — glyph alpha × gradient. Anti-aliasing and
        // per-stop alpha both survive.
        const ck = this.canvasKit;
        const layerPaint = new ck.Paint();
        canvas.saveLayer(layerPaint);
        canvas.drawParagraph(paragraph, node.x, node.y);
        const gradient = this.makePaint(
          node.fill,
          this.paintBox(node),
          node.opacity,
        );
        gradient.setBlendMode(ck.BlendMode.SrcIn);
        // Cover every glyph the paragraph may paint, overhangs included.
        const bleed = node.fontSize * 2;
        canvas.drawRect(
          ck.XYWHRect(
            node.x - bleed,
            node.y - bleed,
            Math.max(node.width, paragraph.getLongestLine()) + bleed * 2,
            Math.max(node.height, paragraph.getHeight()) + bleed * 2,
          ),
          gradient,
        );
        gradient.delete();
        canvas.restore();
        layerPaint.delete();
      } else {
        canvas.drawParagraph(paragraph, node.x, node.y);
      }
      // Stroke pass over the fill, matching SVG paint order (fill, then
      // stroke) so canvas and export agree.
      const strokeParagraph = this.getParagraph(node, "stroke");
      if (strokeParagraph) {
        if (node.stroke?.align === "center") {
          canvas.drawParagraph(strokeParagraph, node.x, node.y);
        } else {
          const maskParagraph = this.getParagraph(node, "mask");
          if (maskParagraph) {
            const strokeLayer = new this.canvasKit.Paint();
            canvas.saveLayer(strokeLayer);
            canvas.drawParagraph(strokeParagraph, node.x, node.y);
            const maskLayer = new this.canvasKit.Paint();
            maskLayer.setBlendMode(
              node.stroke?.align === "outside"
                ? this.canvasKit.BlendMode.DstOut
                : this.canvasKit.BlendMode.DstIn,
            );
            canvas.saveLayer(maskLayer);
            canvas.drawParagraph(maskParagraph, node.x, node.y);
            canvas.restore();
            maskLayer.delete();
            canvas.restore();
            strokeLayer.delete();
          }
        }
      }
      return;
    }

    // No fonts registered yet: placeholder box so the node stays tangible.
    const ck = this.canvasKit;
    const paint = new ck.Paint();
    paint.setStyle(ck.PaintStyle.Stroke);
    paint.setStrokeWidth(1);
    paint.setColor(ck.parseColorString("#94a3b8"));
    canvas.drawRect(
      ck.XYWHRect(node.x, node.y, node.width, node.height),
      paint,
    );
    paint.delete();
    const fallback = {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    };
    this.textInteractionBounds.set(node.id, fallback);
    if (this.scene) {
      setTextLayoutBounds(this.scene.document, node.id, fallback);
    }
  }

  /**
   * Type on a path: arc-length parameterize the target path with Skia's
   * ContourMeasure, advance the pen by per-glyph widths (+ tracking) and
   * place each glyph as an RSXform (position + baseline rotation) in one
   * TextBlob. Layout is fully derived at draw time — moving or editing
   * the path re-flows the text on the next frame. Returns false when the
   * attachment can't render (path/typeface missing) so the caller falls
   * back to the normal paragraph.
   *
   * `flip` walks the path from its end with glyphs rotated 180° — the
   * layout you would get on the reversed path, matching the SVG export.
   *
   * Glyphs past the path's end are hidden like SVG <textPath> overflow.
   */
  private shapeTextOnPath(node: TextNode): {
    glyphs: number[];
    advances: number[];
    top: number;
    bottom: number;
  } | null {
    const ck = this.canvasKit;
    const slant = node.fontStyle ?? "normal";
    const family = this.fonts.resolveProviderFamily(node.fontFamily, slant);
    if (!family) {
      return null;
    }
    const content = normalizeTextPathContent(node.content);
    const fontFeatures = node.otFeatures
      ? Object.entries(node.otFeatures)
          .filter(([name]) => /^[A-Za-z0-9]{4}$/.test(name))
          .map(([name, on]) => ({ name, value: on ? 1 : 0 }))
      : undefined;
    const baseTextStyle = {
      color: ck.parseColorString("#000000"),
      fontFamilies: [family],
      fontSize: node.fontSize,
      letterSpacing: node.letterSpacing,
      fontStyle: {
        weight: { value: node.fontWeight },
        ...(slant === "italic" ? { slant: ck.FontSlant.Italic } : {}),
      },
      fontVariations: [{ axis: "wght", value: node.fontWeight }],
      ...(fontFeatures && fontFeatures.length > 0 ? { fontFeatures } : {}),
    };
    const style = new ck.ParagraphStyle({ textStyle: baseTextStyle });
    const builder = ck.ParagraphBuilder.MakeFromFontProvider(
      style,
      this.fonts.provider,
    );
    const pushRun = (text: string, letterSpacing: number) => {
      builder.pushStyle(
        new ck.TextStyle({ ...baseTextStyle, letterSpacing }),
      );
      builder.addText(text);
      builder.pop();
    };
    if (node.kerning && Object.keys(node.kerning).length > 0) {
      let runStart = 0;
      let spacing =
        node.letterSpacing + kernToPx(kernAt(node.kerning, 0), node.fontSize);
      for (let index = 1; index < content.length; index += 1) {
        const next =
          node.letterSpacing +
          kernToPx(kernAt(node.kerning, index), node.fontSize);
        if (next !== spacing) {
          pushRun(content.slice(runStart, index), spacing);
          runStart = index;
          spacing = next;
        }
      }
      pushRun(content.slice(runStart), spacing);
    } else {
      pushRun(content, node.letterSpacing);
    }
    const paragraph = builder.build();
    paragraph.layout(1_000_000);
    builder.delete();
    const line = paragraph.getShapedLines()[0];
    if (!line) {
      paragraph.delete();
      return null;
    }
    const glyphs: number[] = [];
    const advances: number[] = [];
    for (const run of line.runs) {
      for (let index = 0; index < run.glyphs.length; index += 1) {
        glyphs.push(run.glyphs[index]!);
        const current = run.positions[index * 2] ?? 0;
        const next = run.positions[(index + 1) * 2] ?? current;
        advances.push(Math.max(0, next - current));
      }
    }
    const shaped = {
      glyphs,
      advances,
      top: line.top - line.baseline,
      bottom: line.bottom - line.baseline,
    };
    paragraph.delete();
    return shaped;
  }

  private drawTextOnPath(canvas: Canvas, node: TextNode): boolean {
    const attachment = node.onPath;
    const document = this.scene?.document;
    if (!attachment || !document) {
      return false;
    }

    const pathNode = document.nodes[attachment.pathId];
    if (!pathNode || pathNode.type !== "path") {
      return false;
    }

    const typeface = this.fonts.getTypeface(
      node.fontFamily,
      node.fontWeight,
      node.fontStyle ?? "normal",
    );
    if (!typeface) {
      return false;
    }

    const base = this.getPath(pathNode.d, pathNode.fillRule);
    if (!base) {
      return false;
    }

    const ck = this.canvasKit;

    // Intrinsic path → artboard space: scale + translate, then the path
    // node's rotation about its box centre (same order drawLeaf uses).
    const path = base.copy();
    const sx = pathNode.width / pathNode.intrinsicWidth;
    const sy = pathNode.height / pathNode.intrinsicHeight;
    path.transform([sx, 0, pathNode.x, 0, sy, pathNode.y, 0, 0, 1]);
    if (pathNode.rotation !== 0) {
      const cx = pathNode.x + pathNode.width / 2;
      const cy = pathNode.y + pathNode.height / 2;
      const rad = (pathNode.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      path.transform([
        cos,
        -sin,
        cx - cos * cx + sin * cy,
        sin,
        cos,
        cy - sin * cx - cos * cy,
        0,
        0,
        1,
      ]);
    }

    const contours: Array<{ measure: ContourMeasure; start: number }> = [];
    let total = 0;
    const iter = new ck.ContourMeasureIter(path, false, 1);
    for (let measure = iter.next(); measure; measure = iter.next()) {
      contours.push({ measure, start: total });
      total += measure.length();
    }
    iter.delete();
    path.delete();

    if (contours.length === 0 || total <= 0) {
      return false;
    }

    const shaped = this.shapeTextOnPath(node);
    if (!shaped) {
      for (const contour of contours) {
        contour.measure.delete();
      }
      return false;
    }
    const font = new ck.Font(typeface, node.fontSize);
    const runLength = shaped.advances.reduce((sum, advance) => sum + advance, 0);
    const alignFactor = node.align === "center" ? 0.5 : node.align === "right" ? 1 : 0;
    const remaining = Math.max(0, total - attachment.startOffset - runLength);

    const placedGlyphs: number[] = [];
    const xforms: number[] = [];
    const layout: TextPathGlyph[] = [];
    let pen = attachment.startOffset + remaining * alignFactor;

    for (let i = 0; i < shaped.glyphs.length; i += 1) {
      const width = shaped.advances[i] ?? 0;
      const mid = pen + width / 2;
      pen += width;
      if (mid < 0) {
        continue;
      }
      if (mid > total) {
        break; // overflow past the path's end is hidden
      }

      const distance = attachment.flip ? total - mid : mid;
      const contour =
        contours.find(
          (item) => distance <= item.start + item.measure.length(),
        ) ?? contours[contours.length - 1]!;
      const [px, py, tx, ty] = contour.measure.getPosTan(
        distance - contour.start,
      );
      const cos = attachment.flip ? -tx! : tx!;
      const sin = attachment.flip ? -ty! : ty!;

      const originX = px! - cos * (width / 2);
      const originY = py! - sin * (width / 2);
      placedGlyphs.push(shaped.glyphs[i]!);
      xforms.push(cos, sin, originX, originY);
      layout.push({
        x: px!,
        y: py!,
        angle: (Math.atan2(sin, cos) * 180) / Math.PI,
        originX,
        originY,
        advance: width,
        top: shaped.top,
        bottom: shaped.bottom,
      });
    }

    this.textPathLayouts.set(node.id, layout);
    const liveBounds = textPathLayoutBounds(layout);
    if (liveBounds) {
      this.textPathBounds.set(node.id, liveBounds);
      this.textInteractionBounds.set(node.id, liveBounds);
      if (this.scene) {
        setTextLayoutBounds(this.scene.document, node.id, liveBounds);
      }
    } else {
      this.textPathBounds.delete(node.id);
      this.textInteractionBounds.delete(node.id);
      if (this.scene) {
        setTextLayoutBounds(this.scene.document, node.id, null);
      }
    }

    if (placedGlyphs.length > 0) {
      const blob = ck.TextBlob.MakeFromRSXformGlyphs(
        placedGlyphs,
        xforms,
        font,
      );
      if (blob) {
        const paint = this.makePaint(node.fill, this.paintBox(node), node.opacity);
        canvas.drawTextBlob(blob, 0, 0, paint);
        paint.delete();
        // Stroke pass over the fill, same paint order as SVG export.
        const strokePaint = this.makeStrokePaint(node);
        if (strokePaint) {
          if (node.stroke?.align === "center") {
            canvas.drawTextBlob(blob, 0, 0, strokePaint);
          } else {
            const strokeLayer = new ck.Paint();
            canvas.saveLayer(strokeLayer);
            canvas.drawTextBlob(blob, 0, 0, strokePaint);
            const maskPaint = new ck.Paint();
            maskPaint.setColor(ck.parseColorString("#000000"));
            maskPaint.setBlendMode(
              node.stroke?.align === "outside"
                ? ck.BlendMode.DstOut
                : ck.BlendMode.DstIn,
            );
            canvas.drawTextBlob(blob, 0, 0, maskPaint);
            maskPaint.delete();
            canvas.restore();
            strokeLayer.delete();
          }
          strokePaint.delete();
        }
        blob.delete();
      }
    }

    font.delete();
    for (const contour of contours) {
      contour.measure.delete();
    }
    return true;
  }

  /**
   * Last rendered glyph layout for a text-on-path node, artboard-local.
   * Automation/debug probe; null when the node never rendered on a path.
   */
  getTextPathLayout(nodeId: string): TextPathGlyph[] | null {
    return this.textPathLayouts.get(nodeId) ?? null;
  }

  /** Live glyph-run AABBs for core selection-frame queries. */
  getTextPathInteractionBounds(): ReadonlyMap<string, Bounds> {
    return this.textInteractionBounds;
  }

  /** Live paragraph and path-text AABBs for hit-testing and selection. */
  getTextInteractionBounds(): ReadonlyMap<string, Bounds> {
    return this.textInteractionBounds;
  }

  private getParagraph(
    node: TextNode,
    variant: "fill" | "stroke" | "mask" = "fill",
  ): Paragraph | null {
    if (this.fonts.isEmpty) {
      return null;
    }
    if (variant === "stroke" && (!node.stroke || node.stroke.width <= 0)) {
      return null;
    }

    const slant = node.fontStyle ?? "normal";
    const family = this.fonts.resolveProviderFamily(node.fontFamily, slant);
    if (!family) {
      return null;
    }

    const key = [
      node.content,
      family,
      node.fontSize,
      node.fontWeight,
      slant,
      node.letterSpacing,
      node.lineHeight,
      node.align,
      node.width,
      this.paintKey(node.fill),
      node.opacity,
      node.kerning ? JSON.stringify(node.kerning) : "",
      node.otFeatures ? JSON.stringify(node.otFeatures) : "",
      variant === "stroke" ? `stroke:${JSON.stringify(node.stroke)}` : "",
      variant,
    ].join("|");

    const cache =
      variant === "stroke"
        ? this.strokeParagraphCache
        : variant === "mask"
          ? this.maskParagraphCache
          : this.paragraphCache;
    const cached = cache.get(node.id);
    if (cached && cached.key === key) {
      return cached.paragraph;
    }
    cached?.paragraph.delete();

    const ck = this.canvasKit;
    // Gradient fills paint the glyphs opaque; drawText overlays the
    // gradient with SrcIn, which multiplies alphas.
    const color =
      variant === "mask" || isGradient(node.fill)
        ? ck.parseColorString("#000000")
        : ck.parseColorString(node.fill.color);
    if (variant !== "mask" && !isGradient(node.fill)) {
      color[3] = (color[3] ?? 1) * node.opacity;
    }

    const alignMap = {
      left: ck.TextAlign.Left,
      center: ck.TextAlign.Center,
      right: ck.TextAlign.Right,
    } as const;

    const fontFeatures = node.otFeatures
      ? Object.entries(node.otFeatures).map(([name, on]) => ({
          name,
          value: on ? 1 : 0,
        }))
      : undefined;

    const baseTextStyle = {
      color,
      fontFamilies: [family],
      fontSize: node.fontSize,
      letterSpacing: node.letterSpacing,
      heightMultiplier: node.lineHeight,
      fontStyle: {
        weight: { value: node.fontWeight },
        ...(slant === "italic" ? { slant: ck.FontSlant.Italic } : {}),
      },
      fontVariations: [{ axis: "wght", value: node.fontWeight }],
      ...(fontFeatures ? { fontFeatures } : {}),
    };

    const style = new ck.ParagraphStyle({
      textAlign: alignMap[node.align],
      textStyle: baseTextStyle,
    });

    const builder = ck.ParagraphBuilder.MakeFromFontProvider(
      style,
      this.fonts.provider,
    );

    // Stroke variant: glyphs draw with a stroked foreground paint pushed
    // through the paragraph API (TextStyle.color has no stroke slot).
    const foreground =
      variant === "stroke" ? this.makeStrokePaint(node) : null;
    const background = foreground ? new ck.Paint() : null;
    background?.setColor(ck.TRANSPARENT);
    const pushRun = (textStyle: TextStyle) => {
      if (foreground && background) {
        builder.pushPaintStyle(textStyle, foreground, background);
      } else {
        builder.pushStyle(textStyle);
      }
    };

    const kerning = node.kerning;
    if (kerning && Object.keys(kerning).length > 0) {
      // Per-pair kerning through the paragraph API: letterSpacing is
      // added after each glyph, so a single-character run with adjusted
      // spacing widens/tightens exactly one pair gap. Consecutive
      // characters with equal spacing share a run.
      let runStart = 0;
      let runSpacing =
        node.letterSpacing + kernToPx(kernAt(kerning, 0), node.fontSize);
      const flush = (end: number) => {
        if (end <= runStart) {
          return;
        }
        pushRun(
          new ck.TextStyle({ ...baseTextStyle, letterSpacing: runSpacing }),
        );
        builder.addText(node.content.slice(runStart, end));
        builder.pop();
      };
      for (let i = 1; i < node.content.length; i += 1) {
        const spacing =
          node.letterSpacing + kernToPx(kernAt(kerning, i), node.fontSize);
        if (spacing !== runSpacing) {
          flush(i);
          runStart = i;
          runSpacing = spacing;
        }
      }
      flush(node.content.length);
    } else if (foreground) {
      pushRun(new ck.TextStyle(baseTextStyle));
      builder.addText(node.content);
      builder.pop();
    } else {
      builder.addText(node.content);
    }

    const paragraph = builder.build();
    paragraph.layout(Math.max(node.width, 1));
    builder.delete();
    foreground?.delete();
    background?.delete();

    cache.set(node.id, { key, paragraph });
    return paragraph;
  }

  /**
   * Paragraph metrics of a text node's last built paragraph (automation
   * probe: kerning/feature changes move `width`). Null until the node
   * has rendered as a paragraph.
   */
  getTextMetrics(nodeId: string): TextMetrics | null {
    const entry = this.paragraphCache.get(nodeId);
    return entry
      ? {
          width: entry.paragraph.getLongestLine(),
          height: entry.paragraph.getHeight(),
        }
      : null;
  }

  private paintKey(paint: Paint): string {
    if (paint.type === "solid") {
      return paint.color;
    }
    const stops = paint.stops
      .map((s) => `${s.offset}${s.color}${s.alpha ?? 1}`)
      .join(",");
    return paint.type === "linear-gradient"
      ? `l${paint.angle}:${paint.start ? `${paint.start.x},${paint.start.y}` : ""}:${
          paint.end ? `${paint.end.x},${paint.end.y}` : ""
        }:${stops}`
      : `r${paint.cx},${paint.cy},${paint.r},${paint.fx ?? ""},${paint.fy ?? ""}:${stops}`;
  }

  private makePaint(paint: Paint, box: Bounds, opacity: number): SkPaint {
    const ck = this.canvasKit;
    const skPaint = new ck.Paint();
    skPaint.setAntiAlias(true);

    if (paint.type === "solid") {
      const color = ck.parseColorString(paint.color);
      color[3] = (color[3] ?? 1) * opacity;
      skPaint.setColor(color);
      return skPaint;
    }

    const colors = paint.stops.map((stop) => {
      const color = ck.parseColorString(stop.color);
      color[3] = (color[3] ?? 1) * (stop.alpha ?? 1) * opacity;
      return color;
    });
    const positions = paint.stops.map((stop) => stop.offset);

    let shader;
    if (paint.type === "linear-gradient") {
      const { start, end } = linearGradientPoints(paint, box);
      shader = ck.Shader.MakeLinearGradient(
        [start.x, start.y],
        [end.x, end.y],
        colors,
        positions,
        ck.TileMode.Clamp,
      );
    } else {
      // Radial coordinates are normalized to the box (SVG
      // objectBoundingBox): build the shader in unit space and let the
      // local matrix stretch it — non-square nodes get the same
      // elliptical falloff the exported SVG shows.
      const boxMatrix = [box.width, 0, box.x, 0, box.height, box.y, 0, 0, 1];
      shader =
        paint.fx !== undefined && paint.fy !== undefined
          ? ck.Shader.MakeTwoPointConicalGradient(
              [paint.fx, paint.fy],
              0,
              [paint.cx, paint.cy],
              paint.r,
              colors,
              positions,
              ck.TileMode.Clamp,
              boxMatrix,
            )
          : ck.Shader.MakeRadialGradient(
              [paint.cx, paint.cy],
              paint.r,
              colors,
              positions,
              ck.TileMode.Clamp,
              boxMatrix,
            );
    }
    skPaint.setShader(shader);
    shader.delete();
    return skPaint;
  }

  private getPath(d: string, fillRule: PathFillRule = "nonzero"): Path | null {
    const key = `${fillRule}\u0000${d}`;
    const cached = this.pathCache.get(key);
    if (cached) {
      return cached;
    }

    const path = this.canvasKit.Path.MakeFromSVGString(d);
    if (!path) {
      return null;
    }
    path.setFillType(
      fillRule === "evenodd"
        ? this.canvasKit.FillType.EvenOdd
        : this.canvasKit.FillType.Winding,
    );

    // Cheap eviction: path data strings are few in a logo document.
    if (this.pathCache.size > 512) {
      for (const [key, value] of this.pathCache) {
        value.delete();
        this.pathCache.delete(key);
        break;
      }
    }

    this.pathCache.set(key, path);
    return path;
  }

  /** Cached mask geometry in artboard-local coordinates, rotation included. */
  private getClippingPath(
    node: Exclude<LogoNode, { type: "group" | "text" }>,
  ): Path | null {
    const geometryKey =
      node.type === "rectangle"
        ? `rectangle|${node.cornerRadius}`
        : node.type === "ellipse"
          ? "ellipse"
          : `path|${node.fillRule}|${node.intrinsicWidth}|${node.intrinsicHeight}|${node.d}`;
    const key = `${geometryKey}|${node.x}|${node.y}|${node.width}|${node.height}|${node.rotation}`;
    const cached = this.clipPathCache.get(node.id);
    if (cached?.key === key) {
      return cached.path;
    }
    if (cached) {
      cached.path.delete();
      this.clipPathCache.delete(node.id);
    }

    const path = nodeToSkPath(this.canvasKit, node);
    if (!path) {
      return null;
    }
    this.clipPathCache.set(node.id, { key, path });
    return path;
  }

  private drawRulerGuides(canvas: Canvas, scene: Scene): void {
    const artboard = scene.document.artboards.find(
      (item) => item.id === scene.document.activeArtboardId,
    );
    const guides = artboard?.guides;
    if (!artboard || !guides || (guides.v.length === 0 && guides.h.length === 0)) {
      return;
    }

    const ck = this.canvasKit;
    this.withActiveArtboard(canvas, scene, () => {
      const paint = new ck.Paint();
      paint.setStyle(ck.PaintStyle.Stroke);
      paint.setStrokeWidth(1 / scene.camera.zoom);
      paint.setColor(ck.parseColorString(RULER_GUIDE_COLOR));
      paint.setAntiAlias(true);

      for (const x of guides.v) {
        const path = new ck.Path();
        path.moveTo(x, 0);
        path.lineTo(x, artboard.height);
        canvas.drawPath(path, paint);
        path.delete();
      }
      for (const y of guides.h) {
        const path = new ck.Path();
        path.moveTo(0, y);
        path.lineTo(artboard.width, y);
        canvas.drawPath(path, paint);
        path.delete();
      }
      paint.delete();
    });
  }

  private drawHover(canvas: Canvas, scene: Scene): void {
    const hoveredId = scene.hoveredNodeId;
    if (!hoveredId || scene.selectedNodeIds.includes(hoveredId)) {
      return;
    }

    const node = scene.document.nodes[hoveredId];
    if (!node) {
      return;
    }

    // Groups outline their derived bounds; attached text uses its live glyph run.
    const bounds =
      node.type === "group"
        ? unitBounds(scene.document, node.id)
        : node.type === "text" && node.onPath
          ? this.textPathBounds.get(node.id) ?? null
          : null;
    if (node.type === "group" && !bounds) {
      return;
    }

    const ck = this.canvasKit;
    this.withActiveArtboard(canvas, scene, () => {
      canvas.save();
      if (node.type !== "group" && !bounds && node.rotation !== 0) {
        canvas.rotate(
          node.rotation,
          node.x + node.width / 2,
          node.y + node.height / 2,
        );
      }
      const paint = new ck.Paint();
      paint.setStyle(ck.PaintStyle.Stroke);
      paint.setStrokeWidth(1.5 / scene.camera.zoom);
      const color = ck.parseColorString(activeTheme.selection);
      color[3] = 0.55;
      paint.setColor(color);
      paint.setAntiAlias(true);
      const box = bounds ?? node;
      canvas.drawRect(
        ck.XYWHRect(box.x, box.y, box.width, box.height),
        paint,
      );
      paint.delete();
      canvas.restore();
    });
  }

  private drawSelection(canvas: Canvas, scene: Scene): void {
    const { document, camera, selectedNodeIds } = scene;
    if (selectedNodeIds.length === 0) {
      return;
    }

    const ck = this.canvasKit;
    const artboard = document.artboards.find(
      (item) => item.id === document.activeArtboardId,
    );
    if (!artboard) {
      return;
    }

    const frame = selectionFrame(
      document,
      selectedNodeIds,
      this.textInteractionBounds,
    );
    if (!frame) {
      return;
    }
    const { bounds } = frame;

    canvas.save();
    canvas.translate(artboard.x, artboard.y);
    // A single rotated leaf gets a tilted frame; the rotate handle and
    // the editor's hit-testing rotate the same way (rotateHandlePoint).
    if (frame.rotation !== 0) {
      const center = selectionFrameCenter(frame);
      canvas.rotate(frame.rotation, center.x, center.y);
    }

    const outline = new ck.Paint();
    outline.setStyle(ck.PaintStyle.Stroke);
    outline.setStrokeWidth(1.5 / camera.zoom);
    outline.setColor(ck.parseColorString(activeTheme.selection));
    outline.setAntiAlias(true);
    const dash = ck.PathEffect.MakeDash([6 / camera.zoom, 4 / camera.zoom], 0);
    outline.setPathEffect(dash);
    canvas.drawRect(
      ck.XYWHRect(bounds.x, bounds.y, bounds.width, bounds.height),
      outline,
    );
    dash.delete();
    outline.delete();

    // Align key object: a solid, heavier accent ring around its own
    // bounds so the align/distribute target reads against the dashed
    // shared frame. Multi-selections only (frame rotation is 0 there).
    if (
      selectedNodeIds.length > 1 &&
      scene.keyObjectId &&
      selectedNodeIds.includes(scene.keyObjectId)
    ) {
      const keyBounds = unitBounds(document, scene.keyObjectId);
      if (keyBounds) {
        const ring = new ck.Paint();
        ring.setStyle(ck.PaintStyle.Stroke);
        ring.setStrokeWidth(2.5 / camera.zoom);
        ring.setColor(ck.parseColorString(activeTheme.selection));
        ring.setAntiAlias(true);
        const pad = 2 / camera.zoom;
        canvas.drawRect(
          ck.XYWHRect(
            keyBounds.x - pad,
            keyBounds.y - pad,
            keyBounds.width + pad * 2,
            keyBounds.height + pad * 2,
          ),
          ring,
        );
        ring.delete();
      }
    }

    // Rotate handle: a lollipop above the frame's top edge.
    const stemTop = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y - ROTATE_HANDLE_OFFSET / camera.zoom,
    };
    const stem = new ck.Paint();
    stem.setStyle(ck.PaintStyle.Stroke);
    stem.setStrokeWidth(1.25 / camera.zoom);
    stem.setColor(ck.parseColorString(activeTheme.selection));
    stem.setAntiAlias(true);
    const stemPath = new ck.Path();
    stemPath.moveTo(stemTop.x, bounds.y);
    stemPath.lineTo(stemTop.x, stemTop.y);
    canvas.drawPath(stemPath, stem);
    stemPath.delete();

    const knobFill = new ck.Paint();
    knobFill.setColor(ck.parseColorString("#ffffff"));
    knobFill.setAntiAlias(true);
    canvas.drawCircle(stemTop.x, stemTop.y, 4.5 / camera.zoom, knobFill);
    canvas.drawCircle(stemTop.x, stemTop.y, 4.5 / camera.zoom, stem);
    knobFill.delete();
    stem.delete();

    // Corner + edge handles.
    const handleSize = 8 / camera.zoom;
    const handleFill = new ck.Paint();
    handleFill.setColor(ck.parseColorString("#ffffff"));
    handleFill.setAntiAlias(true);
    const handleStroke = new ck.Paint();
    handleStroke.setStyle(ck.PaintStyle.Stroke);
    handleStroke.setStrokeWidth(1.25 / camera.zoom);
    handleStroke.setColor(ck.parseColorString(activeTheme.selection));
    handleStroke.setAntiAlias(true);

    for (const handle of selectionHandles(bounds)) {
      const rect = ck.XYWHRect(
        handle.x - handleSize / 2,
        handle.y - handleSize / 2,
        handleSize,
        handleSize,
      );
      canvas.drawRect(rect, handleFill);
      canvas.drawRect(rect, handleStroke);
    }

    handleFill.delete();
    handleStroke.delete();
    canvas.restore();
  }

  private drawShapeBuilder(canvas: Canvas, scene: Scene): void {
    const sb = scene.shapeBuilder;
    if (!sb || sb.regions.length === 0) {
      return;
    }

    const ck = this.canvasKit;
    const zoom = scene.camera.zoom;

    this.withActiveArtboard(canvas, scene, () => {
      for (const region of sb.regions) {
        const path = this.getPath(region.d, region.fillRule);
        if (!path) {
          continue;
        }

        // Merged regions read blue, doomed ones red; hover adds weight.
        const baseAlpha =
          region.state === "merged"
            ? 0.32
            : region.state === "deleted"
              ? 0.18
              : 0;
        const fillAlpha = region.hovered ? baseAlpha + 0.14 : baseAlpha;
        if (fillAlpha > 0) {
          const fill = new ck.Paint();
          fill.setAntiAlias(true);
          const color = ck.parseColorString(
            region.state === "deleted" ? "#ef4444" : activeTheme.selection,
          );
          color[3] = fillAlpha;
          fill.setColor(color);
          canvas.drawPath(path, fill);
          fill.delete();
        }

        const stroke = new ck.Paint();
        stroke.setStyle(ck.PaintStyle.Stroke);
        stroke.setAntiAlias(true);
        stroke.setStrokeWidth((region.hovered ? 2 : 1) / zoom);
        const strokeColor = ck.parseColorString(activeTheme.selection);
        strokeColor[3] = region.hovered ? 1 : 0.55;
        stroke.setColor(strokeColor);
        canvas.drawPath(path, stroke);
        stroke.delete();
      }
    });
  }

  private drawGuides(canvas: Canvas, scene: Scene): void {
    const guides = scene.guides;
    if (!guides || guides.length === 0) {
      return;
    }

    const ck = this.canvasKit;
    const artboard = scene.document.artboards.find(
      (item) => item.id === scene.document.activeArtboardId,
    );
    if (!artboard) {
      return;
    }

    canvas.save();
    canvas.translate(artboard.x, artboard.y);

    const paint = new ck.Paint();
    paint.setStyle(ck.PaintStyle.Stroke);
    paint.setStrokeWidth(1 / scene.camera.zoom);
    paint.setColor(ck.parseColorString(GUIDE_COLOR));
    paint.setAntiAlias(true);

    const overshoot = 6 / scene.camera.zoom;
    for (const guide of guides) {
      const path = new ck.Path();
      if (guide.axis === "x") {
        path.moveTo(guide.position, guide.start - overshoot);
        path.lineTo(guide.position, guide.end + overshoot);
      } else {
        path.moveTo(guide.start - overshoot, guide.position);
        path.lineTo(guide.end + overshoot, guide.position);
      }
      canvas.drawPath(path, paint);
      path.delete();
    }

    paint.delete();
    canvas.restore();
  }

  private drawMeasurements(canvas: Canvas, scene: Scene): void {
    const measurements = scene.measurements;
    if (
      !measurements ||
      (measurements.labels.length === 0 && measurements.spacing.length === 0)
    ) {
      return;
    }

    const zoom = scene.camera.zoom;
    this.withActiveArtboard(canvas, scene, () => {
      // Spacing bars are thicker than distance readouts so equal gaps
      // read as a pair at a glance.
      for (const seg of measurements.spacing) {
        this.drawMeasureSegment(canvas, seg, zoom, 2);
      }
      for (const seg of measurements.labels) {
        this.drawMeasureSegment(canvas, seg, zoom, 1);
      }
    });
  }

  /** A gap readout: line with perpendicular end ticks + a px label chip. */
  private drawMeasureSegment(
    canvas: Canvas,
    seg: MeasureSegment,
    zoom: number,
    weight: number,
  ): void {
    const ck = this.canvasKit;
    const paint = new ck.Paint();
    paint.setStyle(ck.PaintStyle.Stroke);
    paint.setStrokeWidth(weight / zoom);
    paint.setColor(ck.parseColorString(GUIDE_COLOR));
    paint.setAntiAlias(true);

    const tick = 4 / zoom;
    const path = new ck.Path();
    if (seg.axis === "x") {
      path.moveTo(seg.from, seg.cross);
      path.lineTo(seg.to, seg.cross);
      path.moveTo(seg.from, seg.cross - tick);
      path.lineTo(seg.from, seg.cross + tick);
      path.moveTo(seg.to, seg.cross - tick);
      path.lineTo(seg.to, seg.cross + tick);
    } else {
      path.moveTo(seg.cross, seg.from);
      path.lineTo(seg.cross, seg.to);
      path.moveTo(seg.cross - tick, seg.from);
      path.lineTo(seg.cross + tick, seg.from);
      path.moveTo(seg.cross - tick, seg.to);
      path.lineTo(seg.cross + tick, seg.to);
    }
    canvas.drawPath(path, paint);
    path.delete();
    paint.delete();

    const mid = (seg.from + seg.to) / 2;
    const offset = 12 / zoom;
    const value = Math.round(seg.distance * 10) / 10;
    if (seg.axis === "x") {
      this.drawMeasureChip(canvas, String(value), mid, seg.cross + offset, zoom);
    } else {
      this.drawMeasureChip(canvas, String(value), seg.cross + offset, mid, zoom);
    }
  }

  /** Rounded label chip at a fixed screen size, skipped if no fonts yet. */
  private drawMeasureChip(
    canvas: Canvas,
    text: string,
    x: number,
    y: number,
    zoom: number,
  ): void {
    const ck = this.canvasKit;
    const family = this.fonts.isEmpty
      ? null
      : this.fonts.resolveFamily("Inter, ui-sans-serif");
    if (!family) {
      return;
    }

    const fontSize = 10 / zoom;
    const style = new ck.ParagraphStyle({
      textAlign: ck.TextAlign.Left,
      textStyle: {
        color: ck.parseColorString("#ffffff"),
        fontFamilies: [family],
        fontSize,
        fontStyle: { weight: { value: 500 } },
        fontVariations: [{ axis: "wght", value: 500 }],
      },
    });
    const builder = ck.ParagraphBuilder.MakeFromFontProvider(
      style,
      this.fonts.provider,
    );
    builder.addText(text);
    const paragraph = builder.build();
    paragraph.layout(10000 / zoom);
    builder.delete();

    const textWidth = paragraph.getLongestLine();
    const textHeight = paragraph.getHeight();
    const padX = 4 / zoom;
    const padY = 2 / zoom;

    const chip = new ck.Paint();
    chip.setColor(ck.parseColorString(GUIDE_COLOR));
    chip.setAntiAlias(true);
    canvas.drawRRect(
      ck.RRectXY(
        ck.XYWHRect(
          x - textWidth / 2 - padX,
          y - textHeight / 2 - padY,
          textWidth + padX * 2,
          textHeight + padY * 2,
        ),
        3 / zoom,
        3 / zoom,
      ),
      chip,
    );
    chip.delete();

    canvas.drawParagraph(paragraph, x - textWidth / 2, y - textHeight / 2);
    paragraph.delete();
  }

  private withActiveArtboard(
    canvas: Canvas,
    scene: Scene,
    draw: () => void,
  ): void {
    const artboard = scene.document.artboards.find(
      (item) => item.id === scene.document.activeArtboardId,
    );
    if (!artboard) {
      return;
    }
    canvas.save();
    canvas.translate(artboard.x, artboard.y);
    draw();
    canvas.restore();
  }

  private drawAnchor(
    canvas: Canvas,
    point: Vec2,
    zoom: number,
    filled: boolean,
  ): void {
    const ck = this.canvasKit;
    const size = 7 / zoom;
    const rect = ck.XYWHRect(
      point.x - size / 2,
      point.y - size / 2,
      size,
      size,
    );

    const fill = new ck.Paint();
    fill.setColor(ck.parseColorString(filled ? activeTheme.selection : "#ffffff"));
    fill.setAntiAlias(true);
    canvas.drawRect(rect, fill);
    fill.delete();

    const stroke = new ck.Paint();
    stroke.setStyle(ck.PaintStyle.Stroke);
    stroke.setStrokeWidth(1.25 / zoom);
    stroke.setColor(ck.parseColorString(activeTheme.selection));
    stroke.setAntiAlias(true);
    canvas.drawRect(rect, stroke);
    stroke.delete();
  }

  private drawHandle(
    canvas: Canvas,
    anchor: Vec2,
    handle: Vec2,
    zoom: number,
  ): void {
    const ck = this.canvasKit;
    const line = new ck.Paint();
    line.setStyle(ck.PaintStyle.Stroke);
    line.setStrokeWidth(1 / zoom);
    line.setColor(ck.parseColorString("#93c5fd"));
    line.setAntiAlias(true);
    const path = new ck.Path();
    path.moveTo(anchor.x, anchor.y);
    path.lineTo(handle.x, handle.y);
    canvas.drawPath(path, line);
    path.delete();
    line.delete();

    const dot = new ck.Paint();
    dot.setColor(ck.parseColorString(activeTheme.selection));
    dot.setAntiAlias(true);
    canvas.drawCircle(handle.x, handle.y, 3.5 / zoom, dot);
    dot.delete();
  }

  private strokeOutlinePaint(zoom: number): SkPaint {
    const ck = this.canvasKit;
    const paint = new ck.Paint();
    paint.setStyle(ck.PaintStyle.Stroke);
    paint.setStrokeWidth(1.5 / zoom);
    paint.setColor(ck.parseColorString(activeTheme.selection));
    paint.setAntiAlias(true);
    return paint;
  }

  private drawPenPreview(canvas: Canvas, scene: Scene): void {
    const preview = scene.penPreview;
    if (!preview || preview.points.length === 0) {
      return;
    }

    const ck = this.canvasKit;
    const zoom = scene.camera.zoom;

    this.withActiveArtboard(canvas, scene, () => {
      const d = pathGeometryToSvg({
        subpaths: [{ closed: false, points: [...preview.points] }],
      });
      const path = ck.Path.MakeFromSVGString(d);
      const outline = this.strokeOutlinePaint(zoom);

      if (path) {
        canvas.drawPath(path, outline);
        path.delete();
      }

      // Rubber band to the cursor.
      const last = preview.points[preview.points.length - 1]!;
      if (preview.cursor) {
        const rubber = new ck.Path();
        const from = last.handleOut ?? last;
        rubber.moveTo(last.x, last.y);
        if (last.handleOut) {
          rubber.cubicTo(
            from.x,
            from.y,
            preview.cursor.x,
            preview.cursor.y,
            preview.cursor.x,
            preview.cursor.y,
          );
        } else {
          rubber.lineTo(preview.cursor.x, preview.cursor.y);
        }
        canvas.drawPath(rubber, outline);
        rubber.delete();
      }
      outline.delete();

      for (const [index, point] of preview.points.entries()) {
        if (point.handleOut) {
          this.drawHandle(canvas, point, point.handleOut, zoom);
        }
        if (point.handleIn) {
          this.drawHandle(canvas, point, point.handleIn, zoom);
        }
        this.drawAnchor(canvas, point, zoom, index === 0);
      }
    });
  }

  private drawPathEdit(canvas: Canvas, scene: Scene): void {
    const edit = scene.pathEdit;
    if (!edit) {
      return;
    }

    const ck = this.canvasKit;
    const zoom = scene.camera.zoom;

    this.withActiveArtboard(canvas, scene, () => {
      const d = pathGeometryToSvg(edit.geometry);
      const path = ck.Path.MakeFromSVGString(d);
      if (path) {
        const outline = this.strokeOutlinePaint(zoom);
        canvas.drawPath(path, outline);
        outline.delete();
        path.delete();
      }

      for (const [si, subpath] of edit.geometry.subpaths.entries()) {
        for (const [pi, point] of subpath.points.entries()) {
          if (point.handleIn) {
            this.drawHandle(canvas, point, point.handleIn, zoom);
          }
          if (point.handleOut) {
            this.drawHandle(canvas, point, point.handleOut, zoom);
          }
          const isSelected =
            edit.selected?.some(
              (ref) => ref.subpath === si && ref.index === pi,
            ) ?? false;
          this.drawAnchor(canvas, point, zoom, isSelected);
        }
      }
    });
  }

  private drawMarquee(canvas: Canvas, scene: Scene): void {
    const marquee = scene.marquee;
    if (!marquee) {
      return;
    }

    const ck = this.canvasKit;
    const rect = ck.XYWHRect(
      marquee.x,
      marquee.y,
      marquee.width,
      marquee.height,
    );

    const fill = new ck.Paint();
    fill.setColor(ck.parseColorString(activeTheme.selection));
    fill.setAlphaf(0.08);
    canvas.drawRect(rect, fill);
    fill.delete();

    const stroke = new ck.Paint();
    stroke.setStyle(ck.PaintStyle.Stroke);
    stroke.setStrokeWidth(1 / scene.camera.zoom);
    stroke.setColor(ck.parseColorString(activeTheme.selection));
    canvas.drawRect(rect, stroke);
    stroke.delete();
  }
}

export type HandleId =
  | "nw"
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w";

export type SelectionHandle = Vec2 & { id: HandleId };

/** Screen-px gap between the frame's top edge and the rotate knob. */
export const ROTATE_HANDLE_OFFSET = 22;

/**
 * Artboard-space centre of the rotate knob for a selection frame —
 * the same point drawSelection draws it at (the frame's own rotation
 * applied), so pointer hit-testing and rendering can never drift.
 */
export function rotateHandlePoint(frame: SelectionFrame, zoom: number): Vec2 {
  const { bounds } = frame;
  const top = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y - ROTATE_HANDLE_OFFSET / zoom,
  };
  return frame.rotation === 0
    ? top
    : rotatePoint(top, selectionFrameCenter(frame), frame.rotation);
}

/** Handle centre points for a selection box, artboard space. */
export function selectionHandles(bounds: Bounds): SelectionHandle[] {
  const { x, y, width, height } = bounds;
  return [
    { id: "nw", x, y },
    { id: "n", x: x + width / 2, y },
    { id: "ne", x: x + width, y },
    { id: "e", x: x + width, y: y + height / 2 },
    { id: "se", x: x + width, y: y + height },
    { id: "s", x: x + width / 2, y: y + height },
    { id: "sw", x, y: y + height },
    { id: "w", x, y: y + height / 2 },
  ];
}
