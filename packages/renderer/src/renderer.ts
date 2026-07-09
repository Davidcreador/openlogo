import type {
  Canvas,
  CanvasKit,
  Paint as SkPaint,
  Paragraph,
  Path,
  Surface,
} from "canvaskit-wasm";
import type {
  Artboard,
  Bounds,
  LogoDocument,
  LogoNode,
  MeasureSegment,
  Paint,
  PathGeometry,
  PathPoint,
  SnapGuide,
  TextNode,
  Vec2,
} from "@openlogo/core";
import {
  getRenderNodesForArtboard,
  pathGeometryToSvg,
  rotatePoint,
  unitBounds,
} from "@openlogo/core";
import type { Camera } from "./camera";
import { screenToWorld } from "./camera";
import { FontRegistry } from "./fonts";

export type Scene = {
  document: LogoDocument;
  camera: Camera;
  selectedNodeIds: readonly string[];
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
    selected?: { subpath: number; index: number } | null;
  } | null;
  /** Shape Builder overlay regions, artboard-local coordinates. */
  shapeBuilder?: {
    regions: ReadonlyArray<{
      d: string;
      state: "pending" | "merged" | "deleted";
      hovered: boolean;
    }>;
  } | null;
};

const SELECTION_COLOR = "#4f6bf6";
const GUIDE_COLOR = "#ec4899";
const RULER_GUIDE_COLOR = "#06b6d4";

type ParagraphCacheEntry = {
  key: string;
  paragraph: Paragraph;
};

/**
 * Draws a LogoDocument to a canvas via CanvasKit and answers hit-tests.
 * Owns the frame loop: callers mutate the scene then call `invalidate()`.
 */
export class SceneRenderer {
  private surface: Surface | null = null;
  private dirty = true;
  private disposed = false;
  private scene: Scene | null = null;
  private dpr = 1;
  private pathCache = new Map<string, Path>();
  private paragraphCache = new Map<string, ParagraphCacheEntry>();

  constructor(
    private readonly canvasKit: CanvasKit,
    private readonly canvas: HTMLCanvasElement,
    readonly fonts: FontRegistry,
  ) {
    this.createSurface();
    const loop = () => {
      if (this.disposed) {
        return;
      }
      if (this.dirty && this.scene && this.surface) {
        this.dirty = false;
        this.draw(this.scene);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  setScene(scene: Scene): void {
    const documentChanged = this.scene?.document !== scene.document;
    this.scene = scene;
    if (documentChanged) {
      // Evict paragraphs whose text node no longer exists — the cache is
      // keyed by node id and would otherwise grow for the whole session.
      for (const [nodeId, entry] of this.paragraphCache) {
        if (!scene.document.nodes[nodeId]) {
          entry.paragraph.delete();
          this.paragraphCache.delete(nodeId);
        }
      }
    }
    this.invalidate();
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** Resize backing store to CSS size * devicePixelRatio. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    if (this.disposed) {
      return;
    }
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.createSurface();
    this.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    for (const path of this.pathCache.values()) {
      path.delete();
    }
    for (const entry of this.paragraphCache.values()) {
      entry.paragraph.delete();
    }
    this.pathCache.clear();
    this.paragraphCache.clear();
    this.surface?.delete();
    this.surface = null;
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
      if (this.nodeContains(node, local)) {
        return node;
      }
    }

    return null;
  }

  private nodeContains(node: LogoNode, worldPoint: Vec2): boolean {
    if (node.type === "group") {
      return false; // hit-testing walks leaves only
    }

    // Undo the node's rotation, then test in its local axis-aligned space.
    const center = {
      x: node.x + node.width / 2,
      y: node.y + node.height / 2,
    };
    const local = rotatePoint(worldPoint, center, -node.rotation);
    const inBox =
      local.x >= node.x &&
      local.x <= node.x + node.width &&
      local.y >= node.y &&
      local.y <= node.y + node.height;

    if (!inBox) {
      return false;
    }

    if (node.type === "ellipse") {
      const dx = (local.x - center.x) / (node.width / 2);
      const dy = (local.y - center.y) / (node.height / 2);
      return dx * dx + dy * dy <= 1;
    }

    if (node.type === "path") {
      const path = this.getPath(node.d);
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
        const ok = stroked.stroke({
          width: Math.max(node.stroke.width, 6),
          cap: this.canvasKit.StrokeCap.Round,
          join: this.canvasKit.StrokeJoin.Round,
        });
        const hit = ok ? stroked.contains(intrinsicX, intrinsicY) : false;
        stroked.delete();
        return hit;
      }
      return false;
    }

    // Rectangles and text: box test is enough.
    return true;
  }

  private createSurface(): void {
    this.surface?.delete();
    this.surface =
      this.canvasKit.MakeWebGLCanvasSurface(this.canvas) ??
      this.canvasKit.MakeSWCanvasSurface(this.canvas);
    if (!this.surface) {
      throw new Error("CanvasKit could not create a rendering surface.");
    }
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

    // Only the active artboard draws: keeps frame cost flat however many
    // artboards the document holds (the switcher is the way between them).
    const active = document.artboards.find(
      (item) => item.id === document.activeArtboardId,
    );
    if (active) {
      this.drawArtboard(canvas, document, active, camera);
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
    shadow.setColor(ck.parseColorString("#1c1921"));
    shadow.setAlphaf(0.1);
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

    // Tree walk instead of the flattened render list: a group with a
    // blend mode must composite its subtree as ONE layer against the
    // backdrop (saveLayer), which per-leaf flattening cannot express.
    // Opacity still cascades per-leaf, matching getRenderNodesForArtboard.
    for (const nodeId of artboard.nodeIds) {
      this.drawSubtree(canvas, document, nodeId, 1);
    }

    canvas.restore();
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
      const layerPaint = node.blendMode ? new this.canvasKit.Paint() : null;
      if (layerPaint && node.blendMode) {
        layerPaint.setBlendMode(this.skBlendMode(node.blendMode));
        canvas.saveLayer(layerPaint);
      }
      for (const childId of node.children) {
        this.drawSubtree(canvas, document, childId, opacity * node.opacity);
      }
      if (layerPaint) {
        canvas.restore();
        layerPaint.delete();
      }
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

  private drawNode(canvas: Canvas, node: LogoNode): void {
    if (node.type === "group") {
      return; // groups draw nothing themselves
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

    const fill = this.makePaint(node.fill, node, node.opacity);
    if (node.blendMode) {
      fill.setBlendMode(this.skBlendMode(node.blendMode));
    }

    if (node.type === "rectangle") {
      const rrect = ck.RRectXY(
        ck.XYWHRect(node.x, node.y, node.width, node.height),
        node.cornerRadius,
        node.cornerRadius,
      );
      canvas.drawRRect(rrect, fill);
      this.strokeNode(canvas, node, (paint) => canvas.drawRRect(rrect, paint));
    } else if (node.type === "ellipse") {
      const rect = ck.XYWHRect(node.x, node.y, node.width, node.height);
      canvas.drawOval(rect, fill);
      this.strokeNode(canvas, node, (paint) => canvas.drawOval(rect, paint));
    } else if (node.type === "path") {
      const path = this.getPath(node.d);
      if (path) {
        canvas.save();
        canvas.translate(node.x, node.y);
        canvas.scale(
          node.width / node.intrinsicWidth,
          node.height / node.intrinsicHeight,
        );
        canvas.drawPath(path, fill);
        this.strokeNode(canvas, node, (paint) => canvas.drawPath(path, paint));
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
  ): void {
    if (!node.stroke || node.stroke.width <= 0) {
      return;
    }

    const ck = this.canvasKit;
    const paint = new ck.Paint();
    paint.setStyle(ck.PaintStyle.Stroke);
    paint.setStrokeWidth(node.stroke.width);
    const color = ck.parseColorString(node.stroke.color);
    color[3] = (color[3] ?? 1) * node.opacity;
    paint.setColor(color);
    paint.setAntiAlias(true);
    drawShape(paint);
    paint.delete();
    void canvas;
  }

  private drawText(canvas: Canvas, node: TextNode): void {
    const paragraph = this.getParagraph(node);
    if (paragraph) {
      canvas.drawParagraph(paragraph, node.x, node.y);
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
  }

  private getParagraph(node: TextNode): Paragraph | null {
    if (this.fonts.isEmpty) {
      return null;
    }

    const family = this.fonts.resolveFamily(node.fontFamily);
    if (!family) {
      return null;
    }

    const key = [
      node.content,
      family,
      node.fontSize,
      node.fontWeight,
      node.letterSpacing,
      node.lineHeight,
      node.align,
      node.width,
      this.paintKey(node.fill),
      node.opacity,
    ].join("|");

    const cached = this.paragraphCache.get(node.id);
    if (cached && cached.key === key) {
      return cached.paragraph;
    }
    cached?.paragraph.delete();

    const ck = this.canvasKit;
    const color = ck.parseColorString(
      node.fill.type === "solid"
        ? node.fill.color
        : (node.fill.stops[0]?.color ?? "#000000"),
    );
    color[3] = (color[3] ?? 1) * node.opacity;

    const alignMap = {
      left: ck.TextAlign.Left,
      center: ck.TextAlign.Center,
      right: ck.TextAlign.Right,
    } as const;

    const style = new ck.ParagraphStyle({
      textAlign: alignMap[node.align],
      textStyle: {
        color,
        fontFamilies: [family],
        fontSize: node.fontSize,
        letterSpacing: node.letterSpacing,
        heightMultiplier: node.lineHeight,
        fontStyle: {
          weight: { value: node.fontWeight },
        },
        fontVariations: [{ axis: "wght", value: node.fontWeight }],
      },
    });

    const builder = ck.ParagraphBuilder.MakeFromFontProvider(
      style,
      this.fonts.provider,
    );
    builder.addText(node.content);
    const paragraph = builder.build();
    paragraph.layout(Math.max(node.width, 1));
    builder.delete();

    this.paragraphCache.set(node.id, { key, paragraph });
    return paragraph;
  }

  private paintKey(paint: Paint): string {
    return paint.type === "solid"
      ? paint.color
      : `${paint.angle}:${paint.stops.map((s) => `${s.offset}${s.color}`).join(",")}`;
  }

  private makePaint(paint: Paint, node: LogoNode, opacity: number): SkPaint {
    const ck = this.canvasKit;
    const skPaint = new ck.Paint();
    skPaint.setAntiAlias(true);

    if (paint.type === "solid") {
      const color = ck.parseColorString(paint.color);
      color[3] = (color[3] ?? 1) * opacity;
      skPaint.setColor(color);
      return skPaint;
    }

    const radians = (paint.angle * Math.PI) / 180;
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    const half = Math.max(node.width, node.height) / 2;
    const dx = Math.cos(radians) * half;
    const dy = Math.sin(radians) * half;

    const shader = ck.Shader.MakeLinearGradient(
      [cx - dx, cy - dy],
      [cx + dx, cy + dy],
      paint.stops.map((stop) => {
        const color = ck.parseColorString(stop.color);
        color[3] = (color[3] ?? 1) * opacity;
        return color;
      }),
      paint.stops.map((stop) => stop.offset),
      ck.TileMode.Clamp,
    );
    skPaint.setShader(shader);
    shader.delete();
    return skPaint;
  }

  private getPath(d: string): Path | null {
    const cached = this.pathCache.get(d);
    if (cached) {
      return cached;
    }

    const path = this.canvasKit.Path.MakeFromSVGString(d);
    if (!path) {
      return null;
    }

    // Cheap eviction: path data strings are few in a logo document.
    if (this.pathCache.size > 512) {
      for (const [key, value] of this.pathCache) {
        value.delete();
        this.pathCache.delete(key);
        break;
      }
    }

    this.pathCache.set(d, path);
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

    // Groups outline their derived bounds; leaves their (rotated) box.
    const bounds =
      node.type === "group" ? unitBounds(scene.document, node.id) : null;
    if (node.type === "group" && !bounds) {
      return;
    }

    const ck = this.canvasKit;
    this.withActiveArtboard(canvas, scene, () => {
      canvas.save();
      if (node.type !== "group" && node.rotation !== 0) {
        canvas.rotate(
          node.rotation,
          node.x + node.width / 2,
          node.y + node.height / 2,
        );
      }
      const paint = new ck.Paint();
      paint.setStyle(ck.PaintStyle.Stroke);
      paint.setStrokeWidth(1.5 / scene.camera.zoom);
      const color = ck.parseColorString(SELECTION_COLOR);
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

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const nodeId of selectedNodeIds) {
      // Unit bounds: group selections use derived child bounds.
      const bounds = unitBounds(document, nodeId);
      if (!bounds) {
        continue;
      }
      minX = Math.min(minX, bounds.x);
      minY = Math.min(minY, bounds.y);
      maxX = Math.max(maxX, bounds.x + bounds.width);
      maxY = Math.max(maxY, bounds.y + bounds.height);
    }

    if (!Number.isFinite(minX)) {
      return;
    }

    canvas.save();
    canvas.translate(artboard.x, artboard.y);

    const outline = new ck.Paint();
    outline.setStyle(ck.PaintStyle.Stroke);
    outline.setStrokeWidth(1.5 / camera.zoom);
    outline.setColor(ck.parseColorString(SELECTION_COLOR));
    outline.setAntiAlias(true);
    const dash = ck.PathEffect.MakeDash([6 / camera.zoom, 4 / camera.zoom], 0);
    outline.setPathEffect(dash);
    canvas.drawRect(
      ck.XYWHRect(minX, minY, maxX - minX, maxY - minY),
      outline,
    );
    dash.delete();
    outline.delete();

    // Corner + edge handles.
    const handleSize = 8 / camera.zoom;
    const handleFill = new ck.Paint();
    handleFill.setColor(ck.parseColorString("#ffffff"));
    handleFill.setAntiAlias(true);
    const handleStroke = new ck.Paint();
    handleStroke.setStyle(ck.PaintStyle.Stroke);
    handleStroke.setStrokeWidth(1.25 / camera.zoom);
    handleStroke.setColor(ck.parseColorString(SELECTION_COLOR));
    handleStroke.setAntiAlias(true);

    for (const handle of selectionHandles(
      { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    )) {
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
        const path = this.getPath(region.d);
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
            region.state === "deleted" ? "#ef4444" : SELECTION_COLOR,
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
        const strokeColor = ck.parseColorString(SELECTION_COLOR);
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
    fill.setColor(ck.parseColorString(filled ? SELECTION_COLOR : "#ffffff"));
    fill.setAntiAlias(true);
    canvas.drawRect(rect, fill);
    fill.delete();

    const stroke = new ck.Paint();
    stroke.setStyle(ck.PaintStyle.Stroke);
    stroke.setStrokeWidth(1.25 / zoom);
    stroke.setColor(ck.parseColorString(SELECTION_COLOR));
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
    dot.setColor(ck.parseColorString(SELECTION_COLOR));
    dot.setAntiAlias(true);
    canvas.drawCircle(handle.x, handle.y, 3.5 / zoom, dot);
    dot.delete();
  }

  private strokeOutlinePaint(zoom: number): SkPaint {
    const ck = this.canvasKit;
    const paint = new ck.Paint();
    paint.setStyle(ck.PaintStyle.Stroke);
    paint.setStrokeWidth(1.5 / zoom);
    paint.setColor(ck.parseColorString(SELECTION_COLOR));
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
            edit.selected?.subpath === si && edit.selected?.index === pi;
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
    fill.setColor(ck.parseColorString(SELECTION_COLOR));
    fill.setAlphaf(0.08);
    canvas.drawRect(rect, fill);
    fill.delete();

    const stroke = new ck.Paint();
    stroke.setStyle(ck.PaintStyle.Stroke);
    stroke.setStrokeWidth(1 / scene.camera.zoom);
    stroke.setColor(ck.parseColorString(SELECTION_COLOR));
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
