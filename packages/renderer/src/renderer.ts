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
  Paint,
  TextNode,
  Vec2,
} from "@openlogo/core";
import { getNodesForArtboard, rotatePoint } from "@openlogo/core";
import type { Camera } from "./camera";
import { screenToWorld } from "./camera";
import { FontRegistry } from "./fonts";

export type Scene = {
  document: LogoDocument;
  camera: Camera;
  selectedNodeIds: readonly string[];
  /** Marquee rectangle in world space while drag-selecting. */
  marquee?: Bounds | null;
};

const EDITOR_BACKGROUND = "#e5e9f0";
const SELECTION_COLOR = "#2563eb";

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
    this.scene = scene;
    this.invalidate();
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** Resize backing store to CSS size * devicePixelRatio. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
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

  /** Topmost visible, unlocked node at a screen point, or null. */
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
    const nodes = getNodesForArtboard(document);

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
      return path.contains(intrinsicX, intrinsicY);
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

    canvas.clear(ck.parseColorString(EDITOR_BACKGROUND));
    canvas.save();
    canvas.scale(this.dpr * camera.zoom, this.dpr * camera.zoom);
    canvas.translate(-camera.offset.x, -camera.offset.y);

    for (const artboard of document.artboards) {
      this.drawArtboard(canvas, document, artboard, camera);
    }

    this.drawSelection(canvas, scene);
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
    shadow.setColor(ck.parseColorString("#0f172a"));
    shadow.setAlphaf(0.12);
    shadow.setMaskFilter(
      ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, 6 / camera.zoom, true),
    );
    canvas.drawRect(
      ck.XYWHRect(
        artboard.x,
        artboard.y + 3 / camera.zoom,
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

    for (const node of getNodesForArtboard(document, artboard.id)) {
      if (node.visible) {
        this.drawNode(canvas, node);
      }
    }

    canvas.restore();
  }

  private drawNode(canvas: Canvas, node: LogoNode): void {
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
      const node = document.nodes[nodeId];
      if (!node) {
        continue;
      }
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
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
