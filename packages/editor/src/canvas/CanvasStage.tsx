import { useCallback, useEffect, useRef, useState } from "react";
import { getCanvasKit } from "../lib/canvaskit";
import { fontStore } from "../lib/font-store";
import {
  KERN_STEP,
  KERN_STEP_LARGE,
  pruneKerning,
  withKernAdjusted,
  type AnchorRef,
  type Bounds,
  type LogoDocument,
  type LogoNode,
  type MeasureSegment,
  type NodePatch,
  type Paint,
  type PathGeometry,
  type PathNode,
  type PathPoint,
  type SnapGuide,
  type Vec2,
  averageAnchors,
  collectLeafNodeIds,
  computeSnap,
  computeSpacingSnap,
  createBoxShapeNode,
  createEllipse,
  createId,
  createPath,
  createRectangle,
  createText,
  createVectorShapeNode,
  cutPathAt,
  findContainerId,
  findSegmentNear,
  getActiveArtboard,
  getAncestorGroupIds,
  getContainerChildIds,
  insertAnchor,
  joinAnchors,
  measureDistances,
  nodeBounds,
  normalizeAngle,
  pathNodeLocalGeometry,
  pixelSnapPatch,
  removeAnchor,
  rotatePoint,
  selectionFrame,
  selectionFrameCenter,
  setAnchorCorner,
  setAnchorSmooth,
  snapValue,
  unitBounds,
} from "@openlogo/core";
import {
  FontRegistry,
  type HandleId,
  SceneRenderer,
  fitBounds,
  panBy,
  rotateHandlePoint,
  screenToWorld,
  selectionHandles,
  worldToScreen,
  zoomAt,
} from "@openlogo/renderer";
import { cloneUnits, resolveUnit } from "../lib/group-ops";
import {
  type GradientHandlePart,
  gradientDefinePaint,
  gradientDragPaint,
  gradientHandlePoints,
  localToFraction,
} from "./gradient-annotator";
import { GradientAnnotator } from "./GradientAnnotator";
import { patchFromLocalGeometry } from "../lib/path-node-geometry";
import { recordTransform } from "../lib/transform-again";
import {
  type ShapeBuilderSession,
  commitShapeBuilder,
  createShapeBuilderSession,
  disposeShapeBuilderSession,
  hitShapeBuilderRegion,
} from "../lib/shape-builder";
import { documentStore, useDocument } from "../state/document";
import { type Tool, useEditorStore } from "../state/editor-store";
import { CanvasRulers } from "./Rulers";

const HANDLE_HIT_RADIUS = 7;
const FONT_URL = "/fonts/Inter-Variable.ttf";

type NodeSnapshot = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  fontSize?: number;
};

type PenSession = {
  points: PathPoint[];
  /** Dragging out handles for the last placed anchor. */
  dragging: boolean;
  cursor: Vec2 | null;
};

type PathEditSession = {
  nodeId: string;
  /** Geometry denormalised into artboard-local coordinates. */
  geometry: PathGeometry;
  drag: {
    subpath: number;
    index: number;
    /** "pull" = ⌥-drag from an anchor: symmetric handles grow out. */
    part: "anchor" | "in" | "out" | "pull";
    /** Convert-anchor click state (part "pull" only). */
    pull?: { hadHandles: boolean; downLocal: Vec2; moved: boolean };
  } | null;
  /** Multi-anchor selection (⇧-click adds); join/average/delete targets. */
  selected: AnchorRef[];
  changed: boolean;
};

type DragState =
  | { kind: "pan"; last: Vec2 }
  | {
      kind: "move";
      startLocal: Vec2;
      snapshots: Map<string, NodeSnapshot>;
      patches: Array<{ nodeId: string; patch: NodePatch }>;
      moved: boolean;
      /** The gesture began as an ⌥-drag duplicate (Transform Again copy flag). */
      copied: boolean;
      /**
       * Unit under the pointer that was ALREADY selected at press time —
       * a no-move plain click on it marks/unmarks the align key object.
       */
      reclickedUnitId: string | null;
      /** Final applied delta including snapping (Transform Again record). */
      appliedDx: number;
      appliedDy: number;
      /** Static snap candidates: unselected nodes + the artboard box. */
      snapTargets: Bounds[];
      guides: SnapGuide[];
      /** Equal-spacing gap indicators while spacing-snapped. */
      spacingGaps: MeasureSegment[];
      /** Distance readouts to nearby edges while snapped. */
      distanceLabels: MeasureSegment[];
    }
  | {
      kind: "resize";
      handle: HandleId;
      startLocal: Vec2;
      startBounds: Bounds;
      /** Selection-frame tilt: non-zero only for a single rotated leaf. */
      frameRotation: number;
      /** Last applied bounds (Transform Again scale record). */
      lastBounds: Bounds;
      snapshots: Map<string, NodeSnapshot>;
      patches: Array<{ nodeId: string; patch: NodePatch }>;
      moved: boolean;
      snapTargets: Bounds[];
      guides: SnapGuide[];
      spacingGaps: MeasureSegment[];
      distanceLabels: MeasureSegment[];
    }
  | {
      kind: "rotate";
      /** Rotation pivot: the selection frame's centre, artboard-local. */
      pivot: Vec2;
      /** Pointer angle at grab, degrees. */
      startPointerAngle: number;
      /** First snapshot's rotation — the ⇧ 15°-snap reference. */
      baseRotation: number;
      /** Last applied delta, degrees. */
      delta: number;
      snapshots: Map<string, NodeSnapshot>;
      patches: Array<{ nodeId: string; patch: NodePatch }>;
      moved: boolean;
    }
  | { kind: "marquee"; startLocal: Vec2; current: Bounds | null }
  | { kind: "guide"; axis: "v" | "h"; index: number; value: number }
  | {
      /** Repositioning an artboard on the shared canvas by its label. */
      kind: "artboard";
      artboardId: string;
      /** Pointer-down position, world space. */
      startWorld: Vec2;
      /** Board origin at pointer-down. */
      origin: Vec2;
      /** Live (snapped) board origin; rides in syncScene's document only. */
      current: Vec2;
      /** Other boards' rects, world space — edge snap targets. */
      snapTargets: Bounds[];
      moved: boolean;
    }
  | {
      kind: "draw";
      tool: Tool;
      /** Stable id so the ghost stays one node across preview frames. */
      ghostId: string;
      start: Vec2;
      current: Vec2;
      shift: boolean;
      moved: boolean;
    }
  | {
      /** Gradient annotator (G tool): drag a handle or define a new line. */
      kind: "gradient";
      nodeId: string;
      part: GradientHandlePart | "define";
      /** Paint being edited, updated per move (previewed, committed on up). */
      paint: Paint;
      /** Press point as a fraction of the node box (unrotated). */
      startFrac: Vec2;
      moved: boolean;
    };

/** Tools that drag-to-draw; a plain click places the default size. */
const SHAPE_DRAW_TOOLS = new Set<Tool>([
  "rectangle",
  "ellipse",
  "triangle",
  "polygon",
  "star",
  "line",
  "arrow",
]);

/**
 * Snapshot the drawable leaves under the given selection units (groups
 * expand to their descendants) — drags patch leaves, never groups.
 */
function snapshotNodes(nodeIds: readonly string[]): Map<string, NodeSnapshot> {
  const document = documentStore.document;
  const map = new Map<string, NodeSnapshot>();
  for (const nodeId of collectLeafNodeIds(document, nodeIds)) {
    const node = document.nodes[nodeId];
    if (node && !node.locked) {
      map.set(nodeId, {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rotation: node.rotation,
        ...(node.type === "text" ? { fontSize: node.fontSize } : {}),
      });
    }
  }
  return map;
}

function snapshotBounds(snapshots: Map<string, NodeSnapshot>): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const snap of snapshots.values()) {
    minX = Math.min(minX, snap.x);
    minY = Math.min(minY, snap.y);
    maxX = Math.max(maxX, snap.x + snap.width);
    maxY = Math.max(maxY, snap.y + snap.height);
  }

  return Number.isFinite(minX)
    ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    : null;
}

function resizeBounds(
  start: Bounds,
  handle: HandleId,
  dx: number,
  dy: number,
): Bounds {
  let { x, y, width, height } = start;

  if (handle.includes("w")) {
    x += dx;
    width -= dx;
  }
  if (handle.includes("e")) {
    width += dx;
  }
  if (handle.includes("n")) {
    y += dy;
    height -= dy;
  }
  if (handle.includes("s")) {
    height += dy;
  }

  // Clamp without letting the box flip.
  if (width < 8) {
    if (handle.includes("w")) {
      x -= 8 - width;
    }
    width = 8;
  }
  if (height < 8) {
    if (handle.includes("n")) {
      y -= 8 - height;
    }
    height = 8;
  }

  return { x, y, width, height };
}

function collectSnapTargets(excludedIds: ReadonlySet<string>): Bounds[] {
  const document = documentStore.document;
  const artboard = getActiveArtboard(document);
  const targets: Bounds[] = [
    { x: 0, y: 0, width: artboard.width, height: artboard.height },
  ];

  // Top-level units: leaves snap to their box, groups to derived bounds.
  // A unit is excluded when it, or anything inside it, is being dragged.
  for (const nodeId of artboard.nodeIds) {
    const node = document.nodes[nodeId];
    if (!node || !node.visible) {
      continue;
    }
    const containsExcluded =
      excludedIds.has(nodeId) ||
      collectLeafNodeIds(document, [nodeId]).some((id) => excludedIds.has(id));
    if (containsExcluded) {
      continue;
    }
    // Rotated leaves snap by their rotated AABB — the box on screen.
    const bounds =
      node.type === "group" ? unitBounds(document, nodeId) : nodeBounds(node);
    if (bounds) {
      targets.push(bounds);
    }
  }

  // Ruler guides snap as zero-thickness lines.
  for (const x of artboard.guides?.v ?? []) {
    targets.push({ x, y: 0, width: 0, height: artboard.height });
  }
  for (const y of artboard.guides?.h ?? []) {
    targets.push({ x: 0, y, width: artboard.width, height: 0 });
  }

  return targets;
}

/** Union of derived unit bounds over a selection. */
function selectionUnitBounds(
  document: LogoDocument,
  nodeIds: readonly string[],
): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const nodeId of nodeIds) {
    const bounds = unitBounds(document, nodeId);
    if (!bounds) {
      continue;
    }
    minX = Math.min(minX, bounds.x);
    minY = Math.min(minY, bounds.y);
    maxX = Math.max(maxX, bounds.x + bounds.width);
    maxY = Math.max(maxY, bounds.y + bounds.height);
  }

  return Number.isFinite(minX)
    ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    : null;
}

/** Rotate a vector (not a point) by `degrees`. */
function rotateVec(v: Vec2, degrees: number): Vec2 {
  return rotatePoint(v, { x: 0, y: 0 }, degrees);
}

/** Pointer angle around a pivot, degrees. */
function pointerAngle(local: Vec2, pivot: Vec2): number {
  return (Math.atan2(local.y - pivot.y, local.x - pivot.x) * 180) / Math.PI;
}

function TextEditOverlay({
  nodeId,
  onDone,
  onKern,
}: {
  nodeId: string;
  onDone: (nodeId: string, content: string, commit: boolean) => void;
  /** ⌥←/⌥→ with the caret between two glyphs: adjust that pair's kerning. */
  onKern: (
    nodeId: string,
    pairIndex: number,
    delta: number,
    draft: string,
  ) => void;
}) {
  const document = useDocument();
  const camera = useEditorStore((state) => state.camera);
  const node = document.nodes[nodeId];
  const [draft, setDraft] = useState(
    node?.type === "text" ? node.content : "",
  );
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  if (!node || node.type !== "text") {
    return null;
  }

  const artboard = getActiveArtboard(document);
  const topLeft = worldToScreen(camera, {
    x: node.x + artboard.x,
    y: node.y + artboard.y,
  });

  return (
    <textarea
      ref={inputRef}
      className="text-edit-overlay absolute z-20 m-0 resize-none overflow-hidden whitespace-nowrap border border-dashed border-accent bg-transparent p-0 outline-none"
      value={draft}
      onChange={(event) => setDraft(event.target.value.replace(/\n/g, ""))}
      onBlur={() => onDone(nodeId, draft, true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onDone(nodeId, draft, true);
        } else if (event.key === "Escape") {
          event.stopPropagation();
          onDone(nodeId, draft, false);
        } else if (
          event.altKey &&
          (event.key === "ArrowLeft" || event.key === "ArrowRight")
        ) {
          // Illustrator kerning: caret between two glyphs, ⌥←/⌥→
          // tightens/loosens that pair (⇧ for the coarse step).
          const target = event.target as HTMLTextAreaElement;
          const caret = target.selectionStart ?? 0;
          if (
            target.selectionEnd === caret &&
            caret > 0 &&
            caret < draft.length
          ) {
            event.preventDefault();
            const step = event.shiftKey ? KERN_STEP_LARGE : KERN_STEP;
            onKern(
              nodeId,
              caret - 1,
              event.key === "ArrowRight" ? step : -step,
              draft,
            );
          }
        }
      }}
      style={{
        left: topLeft.x,
        top: topLeft.y,
        width: Math.max(40, node.width * camera.zoom),
        height: Math.max(24, node.height * camera.zoom),
        fontFamily: node.fontFamily,
        fontWeight: node.fontWeight,
        fontStyle: node.fontStyle ?? "normal",
        fontSize: node.fontSize * camera.zoom,
        letterSpacing: node.letterSpacing * camera.zoom,
        lineHeight: node.lineHeight,
        textAlign: node.align,
        color: node.fill.type === "solid" ? node.fill.color : "#111827",
      }}
      aria-label="Edit text"
    />
  );
}

function makeNodeForTool(tool: Tool, point: Vec2): LogoNode | null {
  const centered = (w: number, h: number) => ({
    x: Math.round(point.x - w / 2),
    y: Math.round(point.y - h / 2),
  });

  switch (tool) {
    case "rectangle":
      return createRectangle(centered(120, 80));
    case "ellipse":
      return createEllipse(centered(96, 96));
    case "triangle":
    case "polygon":
    case "star":
      return createBoxShapeNode(
        { kind: tool },
        { ...centered(96, 96), width: 96, height: 96 },
      );
    case "line":
    case "arrow":
      return createVectorShapeNode(
        { kind: tool },
        { x: Math.round(point.x - 60), y: Math.round(point.y) },
        { x: Math.round(point.x + 60), y: Math.round(point.y) },
      );
    case "path":
      return createPath(centered(96, 96));
    case "text": {
      const node = createText({ ...centered(220, 56), content: "Brand" });
      return node;
    }
    default:
      return null;
  }
}

/** Drag rect for box shapes; Shift constrains to a square. */
function drawBoxFrom(start: Vec2, current: Vec2, shift: boolean): Bounds {
  let dx = current.x - start.x;
  let dy = current.y - start.y;
  if (shift) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * side;
    dy = (dy < 0 ? -1 : 1) * side;
  }
  return {
    x: Math.min(start.x, start.x + dx),
    y: Math.min(start.y, start.y + dy),
    width: Math.max(1, Math.abs(dx)),
    height: Math.max(1, Math.abs(dy)),
  };
}

/** Drag end point for vector shapes; Shift snaps the angle to 45°. */
function drawEndFrom(start: Vec2, current: Vec2, shift: boolean): Vec2 {
  if (!shift) {
    return current;
  }
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) {
    return current;
  }
  const snapped = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI) / 4;
  return {
    x: start.x + Math.cos(snapped) * length,
    y: start.y + Math.sin(snapped) * length,
  };
}

/** The node a draw gesture would commit right now (also the ghost). */
function buildDraftShape(drag: Extract<DragState, { kind: "draw" }>): LogoNode | null {
  const { tool, start, current, shift } = drag;

  if (tool === "line" || tool === "arrow") {
    const node = createVectorShapeNode(
      { kind: tool },
      start,
      drawEndFrom(start, current, shift),
    );
    return node ? { ...node, id: drag.ghostId } : null;
  }

  const box = drawBoxFrom(start, current, shift);
  if (tool === "rectangle") {
    return {
      ...createRectangle({ x: box.x, y: box.y }),
      id: drag.ghostId,
      width: box.width,
      height: box.height,
      cornerRadius: 0,
    };
  }
  if (tool === "ellipse") {
    return {
      ...createEllipse({ x: box.x, y: box.y }),
      id: drag.ghostId,
      width: box.width,
      height: box.height,
    };
  }
  if (tool === "triangle" || tool === "polygon" || tool === "star") {
    const node = createBoxShapeNode({ kind: tool }, box);
    return node ? { ...node, id: drag.ghostId } : null;
  }
  return null;
}

export function CanvasStage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const penRef = useRef<PenSession | null>(null);
  const editRef = useRef<PathEditSession | null>(null);
  /** Scissors sub-mode within bezier editing (C toggles). */
  const scissorsRef = useRef(false);
  const sbRef = useRef<ShapeBuilderSession | null>(null);
  const hoverRef = useRef<string | null>(null);
  /** ⌥-hover distance readouts between the selection and a hovered unit. */
  const measureRef = useRef<MeasureSegment[] | null>(null);
  const spaceRef = useRef(false);
  const editingTextRef = useRef<string | null>(null);
  const cameraFittedRef = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  /** Transient status line (handle symmetry mode, shape builder help). */
  const [handleHint, setHandleHint] = useState<string | null>(null);

  const document = useDocument();
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const keyObjectId = useEditorStore((state) => state.keyObjectId);
  const camera = useEditorStore((state) => state.camera);
  const tool = useEditorStore((state) => state.tool);
  const setTool = useEditorStore((state) => state.setTool);
  const setSelection = useEditorStore((state) => state.setSelection);
  const setCamera = useEditorStore((state) => state.setCamera);
  const setRendererReady = useEditorStore((state) => state.setRendererReady);
  const setEditingPathId = useEditorStore((state) => state.setEditingPathId);

  const syncScene = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) {
      return;
    }
    const state = useEditorStore.getState();
    const drag = dragRef.current;
    const pen = penRef.current;
    const edit = editRef.current;

    // Live guide-drag preview without touching history.
    let sceneDocument = documentStore.document;
    if (drag?.kind === "guide") {
      const artboard = getActiveArtboard(sceneDocument);
      const guides = {
        v: [...(artboard.guides?.v ?? [])],
        h: [...(artboard.guides?.h ?? [])],
      };
      const list = drag.axis === "v" ? guides.v : guides.h;
      if (drag.index === -1) {
        list.push(drag.value);
      } else {
        list[drag.index] = drag.value;
      }
      sceneDocument = {
        ...sceneDocument,
        artboards: sceneDocument.artboards.map((item) =>
          item.id === artboard.id ? { ...item, guides } : item,
        ),
      };
    }

    // Live artboard reposition preview — same pattern as guide drags:
    // the moved board rides in the scene document only, committed as one
    // update-artboard command on pointer-up.
    if (drag?.kind === "artboard" && drag.moved) {
      sceneDocument = {
        ...sceneDocument,
        artboards: sceneDocument.artboards.map((item) =>
          item.id === drag.artboardId
            ? { ...item, x: drag.current.x, y: drag.current.y }
            : item,
        ),
      };
    }

    // Drag-to-draw ghost: the pending shape rides in the scene document
    // only — nothing is committed (or undoable) until pointer-up.
    if (drag?.kind === "draw" && drag.moved) {
      const ghost = buildDraftShape(drag);
      if (ghost) {
        const artboard = getActiveArtboard(sceneDocument);
        sceneDocument = {
          ...sceneDocument,
          nodes: { ...sceneDocument.nodes, [ghost.id]: ghost },
          artboards: sceneDocument.artboards.map((item) =>
            item.id === artboard.id
              ? { ...item, nodeIds: [...item.nodeIds, ghost.id] }
              : item,
          ),
        };
      }
    }

    const sb = sbRef.current;
    renderer.setScene({
      document: sceneDocument,
      camera: state.camera,
      selectedNodeIds: edit || sb ? [] : state.selectedNodeIds,
      keyObjectId: edit || sb ? null : state.keyObjectId,
      hoveredNodeId: edit || pen || sb ? null : hoverRef.current,
      hiddenNodeId: editingTextRef.current,
      marquee: drag?.kind === "marquee" ? drag.current : null,
      guides:
        drag?.kind === "move" || drag?.kind === "resize" ? drag.guides : null,
      measurements:
        drag?.kind === "move" || drag?.kind === "resize"
          ? { labels: drag.distanceLabels, spacing: drag.spacingGaps }
          : measureRef.current && measureRef.current.length > 0
            ? { labels: measureRef.current, spacing: [] }
            : null,
      penPreview: pen ? { points: pen.points, cursor: pen.cursor } : null,
      pathEdit: edit
        ? { geometry: edit.geometry, selected: edit.selected }
        : null,
      shapeBuilder: sb
        ? {
            regions: sb.regions.map((region) => ({
              d: region.d,
              state: region.state,
              hovered: region.id === sb.hoveredId,
            })),
          }
        : null,
    });
  }, []);

  // Init CanvasKit + renderer once.
  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) {
      return;
    }

    let observer: ResizeObserver | null = null;
    let fontsForCleanup: FontRegistry | null = null;

    void (async () => {
      const canvasKit = await getCanvasKit();
      if (cancelled) {
        return;
      }

      const fonts = new FontRegistry(canvasKit);
      fontsForCleanup = fonts;
      try {
        const fontData = await (await fetch(FONT_URL)).arrayBuffer();
        fonts.register("Inter", fontData);
      } catch (error) {
        console.warn("Font load failed; text renders as placeholder.", error);
      }
      if (cancelled) {
        return;
      }

      const renderer = new SceneRenderer(canvasKit, canvas, fonts);
      rendererRef.current = renderer;
      fontStore.attach(fonts, renderer);

      if (import.meta.env.DEV) {
        // Automation/debug hook (see main.tsx): exposes the live renderer
        // so scripts can probe derived state like text-on-path layouts.
        const hook = (window as unknown as Record<string, unknown>)
          .__openlogo as Record<string, unknown> | undefined;
        if (hook) {
          hook.renderer = renderer;
        }
      }

      const applySize = () => {
        const rect = container.getBoundingClientRect();
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1);
        useEditorStore
          .getState()
          .setViewport({ width: rect.width, height: rect.height });

        if (!cameraFittedRef.current && rect.width > 0) {
          cameraFittedRef.current = true;
          const artboard = getActiveArtboard(documentStore.document);
          useEditorStore
            .getState()
            .setCamera(fitBounds(artboard, rect.width, rect.height));
        }
        syncScene();
      };

      observer = new ResizeObserver(applySize);
      observer.observe(container);
      applySize();
      setRendererReady(true);
    })();

    return () => {
      cancelled = true;
      observer?.disconnect();
      fontStore.detach();
      rendererRef.current?.dispose();
      rendererRef.current = null;
      fontsForCleanup?.dispose();
    };
  }, [syncScene, setRendererReady]);

  // Push scene whenever document / camera / selection change.
  useEffect(() => {
    syncScene();
  }, [document, camera, selectedNodeIds, keyObjectId, syncScene]);

  // Space bar toggles temporary pan mode.
  useEffect(() => {
    function isEditable(target: EventTarget | null): boolean {
      return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      );
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === " " && !isEditable(event.target) && !event.repeat) {
        event.preventDefault();
        spaceRef.current = true;
        setSpaceHeld(true);
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key === " ") {
        spaceRef.current = false;
        setSpaceHeld(false);
      }
      // Releasing ⌥ drops the hover-measure overlay immediately.
      if (event.key === "Alt" && measureRef.current) {
        measureRef.current = null;
        syncScene();
      }
    }
    function onBlur() {
      // Keyups delivered to another app never reach us: drop every
      // modifier-conditioned state so nothing sticks across ⌘-Tab.
      spaceRef.current = false;
      setSpaceHeld(false);
      if (measureRef.current || hoverRef.current) {
        measureRef.current = null;
        hoverRef.current = null;
        syncScene();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [syncScene]);

  // Wheel zoom/pan must use a native non-passive listener: React 17+
  // attaches synthetic onWheel passively at the root, so preventDefault()
  // there is ignored and a ctrlKey pinch-wheel zooms the whole page.
  useEffect(() => {
    const maybeCanvas = canvasRef.current;
    if (!maybeCanvas) {
      return;
    }
    const canvas: HTMLCanvasElement = maybeCanvas;

    function screenPoint(point: { clientX: number; clientY: number }): Vec2 {
      const rect = canvas.getBoundingClientRect();
      return { x: point.clientX - rect.left, y: point.clientY - rect.top };
    }

    function onWheel(event: WheelEvent) {
      // Consume pinch AND scroll: pinch would page-zoom, scroll would
      // rubber-band / back-swipe ancestors.
      event.preventDefault();
      const camera = useEditorStore.getState().camera;
      if (event.ctrlKey || event.metaKey) {
        const factor = Math.exp(-event.deltaY * 0.0015);
        setCamera(zoomAt(camera, screenPoint(event), camera.zoom * factor));
      } else {
        setCamera(panBy(camera, { x: -event.deltaX, y: -event.deltaY }));
      }
    }

    // Safari trackpad pinch arrives as gesture* events, not ctrlKey wheels.
    type SafariGestureEvent = Event & {
      scale?: number;
      clientX?: number;
      clientY?: number;
    };
    let gestureScale = 1;
    function onGestureStart(event: Event) {
      event.preventDefault();
      gestureScale = (event as SafariGestureEvent).scale ?? 1;
    }
    function onGestureChange(event: Event) {
      event.preventDefault();
      const gesture = event as SafariGestureEvent;
      const scale = gesture.scale ?? 1;
      if (gestureScale === 0) {
        gestureScale = scale;
        return;
      }
      const factor = scale / gestureScale;
      gestureScale = scale;
      const screen =
        gesture.clientX !== undefined && gesture.clientY !== undefined
          ? screenPoint({ clientX: gesture.clientX, clientY: gesture.clientY })
          : { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
      const camera = useEditorStore.getState().camera;
      setCamera(zoomAt(camera, screen, camera.zoom * factor));
    }
    function onGestureEnd(event: Event) {
      event.preventDefault();
    }

    // Pinch over rulers/panels must not page-zoom either; pinch wheels
    // always carry ctrlKey, so this never blocks plain panel scrolling.
    function onWindowWheel(event: WheelEvent) {
      if (event.ctrlKey) {
        event.preventDefault();
      }
    }

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("gesturestart", onGestureStart, { passive: false });
    canvas.addEventListener("gesturechange", onGestureChange, {
      passive: false,
    });
    canvas.addEventListener("gestureend", onGestureEnd, { passive: false });
    window.addEventListener("wheel", onWindowWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("gesturestart", onGestureStart);
      canvas.removeEventListener("gesturechange", onGestureChange);
      canvas.removeEventListener("gestureend", onGestureEnd);
      window.removeEventListener("wheel", onWindowWheel);
    };
  }, [setCamera]);

  // Leaving the pen tool cancels an in-progress path.
  useEffect(() => {
    if (tool !== "pen" && penRef.current) {
      penRef.current = null;
      syncScene();
    }
  }, [tool, syncScene]);

  // Switching tools commits an open bezier edit session — otherwise the
  // stale session captures the new tool's first click.
  useEffect(() => {
    if (tool !== "select" && editRef.current) {
      commitPathEdit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  // Shape Builder session: entering the tool decomposes the selection
  // into regions; leaving (commit or cancel) disposes them.
  useEffect(() => {
    if (tool !== "shapeBuilder") {
      return;
    }

    let cancelled = false;
    const selection = useEditorStore.getState().selectedNodeIds;
    void createShapeBuilderSession(selection).then((session) => {
      if (cancelled) {
        if (session) {
          disposeShapeBuilderSession(session);
        }
        return;
      }
      // Needs 2–8 overlapping fill shapes, and the document must not have
      // changed while the session was being built; bounce back otherwise.
      if (!session || session.document !== documentStore.document) {
        if (session) {
          disposeShapeBuilderSession(session);
        }
        useEditorStore.getState().setTool("select");
        return;
      }
      sbRef.current = session;
      hoverRef.current = null;
      setHandleHint(
        "Shape Builder: click = merge · ⌥ click = delete · Enter = apply · Esc = cancel",
      );
      syncScene();
    });

    // Regions freeze the operands' geometry at session start. Any document
    // change underneath (nudge, ⌘D, ⌘Z, a drag committing…) makes them
    // stale, so it cancels the session instead of committing wrong shapes.
    const unsubscribe = documentStore.subscribe(() => {
      const session = sbRef.current;
      if (session && documentStore.document !== session.document) {
        useEditorStore.getState().setTool("select"); // cleanup disposes
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
      setHandleHint(null);
      if (sbRef.current) {
        disposeShapeBuilderSession(sbRef.current);
        sbRef.current = null;
        syncScene();
      }
    };
  }, [tool, syncScene]);

  // Enter/Escape finish pen drawing and bezier editing. This handler is
  // registered before App's window handler (child effects mount first) and
  // marks consumed keys with stopImmediatePropagation so a key handled by
  // a modal session never ALSO clears selection / pops group scope in App.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }

      const consume = () => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };

      // Undo/redo while a gesture or edit session is in flight: abort the
      // gesture first so the undo applies to a clean document and the
      // still-held pointer can't re-commit pre-undo state (or wipe redo).
      // Not consumed — App's handler performs the actual undo/redo.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        if (editRef.current) {
          cancelPathEdit();
        }
        cancelActiveDrag();
        return;
      }

      if (dragRef.current) {
        // Esc reverts the in-flight gesture instead of clearing selection.
        if (event.key === "Escape") {
          consume();
          cancelActiveDrag();
          return;
        }
        // Tool shortcuts (and delete) mid-gesture would strand the drag
        // state and commit half-applied patches; swallow them.
        if (
          !event.metaKey &&
          !event.ctrlKey &&
          (/^[a-z]$/i.test(event.key) ||
            event.key === "Backspace" ||
            event.key === "Delete")
        ) {
          event.stopImmediatePropagation();
          return;
        }
      }

      if (sbRef.current) {
        if (event.key === "Enter") {
          consume();
          const session = sbRef.current;
          sbRef.current = null; // guards against a second Enter mid-commit
          void commitShapeBuilder(session).then((newIds) => {
            disposeShapeBuilderSession(session);
            const state = useEditorStore.getState();
            if (newIds) {
              state.setSelection(newIds);
            }
            state.setTool("select");
          });
        } else if (event.key === "Escape") {
          consume();
          useEditorStore.getState().setTool("select"); // cleanup disposes
        }
        return;
      }

      if (penRef.current) {
        if (event.key === "Enter") {
          consume();
          finalizePen(false);
        } else if (event.key === "Escape") {
          consume();
          // Illustrator behavior: Esc KEEPS the anchors placed so far —
          // the open path commits as it stands and the editor exits to
          // the select tool. Only a path with <2 anchors is discarded.
          if (penRef.current.points.length >= 2) {
            finalizePen(false);
          } else {
            cancelPen();
            setTool("select");
          }
        }
        return;
      }

      if (editRef.current) {
        const edit = editRef.current;

        if (event.key === "Enter") {
          consume();
          commitPathEdit();
          return;
        }
        if (event.key === "Escape") {
          consume();
          // Esc backs out of scissors before it backs out of editing.
          if (scissorsRef.current) {
            scissorsRef.current = false;
            setHandleHint(null);
            return;
          }
          cancelPathEdit();
          return;
        }

        // C toggles scissors within the edit session.
        if (
          event.code === "KeyC" &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          consume();
          scissorsRef.current = !scissorsRef.current;
          setHandleHint(
            scissorsRef.current
              ? "Scissors: click an anchor or segment to cut · C/Esc cancels"
              : null,
          );
          return;
        }

        // ⌘J join / ⌥⌘J average (event.code: ⌥J types "∆" as event.key).
        if (event.code === "KeyJ" && (event.metaKey || event.ctrlKey)) {
          consume();
          if (event.altKey) {
            averageAnchorsInEdit(
              event.shiftKey ? "horizontal" : event.ctrlKey && event.metaKey ? "vertical" : "both",
            );
          } else {
            joinAnchorsInEdit();
          }
          return;
        }

        if (
          (event.key === "Backspace" || event.key === "Delete") &&
          edit.selected.length > 0
        ) {
          event.preventDefault();
          // Remove back-to-front so earlier indices stay valid.
          const ordered = [...edit.selected].sort(
            (a, b) => b.subpath - a.subpath || b.index - a.index,
          );
          let next: PathGeometry | null = edit.geometry;
          const droppedSubpaths = new Set<number>();
          for (const ref of ordered) {
            if (droppedSubpaths.has(ref.subpath)) {
              continue; // the whole subpath already fell away
            }
            const before = next.subpaths.length;
            next = removeAnchor(next, ref.subpath, ref.index);
            if (!next) {
              break;
            }
            if (next.subpaths.length !== before) {
              droppedSubpaths.add(ref.subpath);
            }
          }

          if (!next) {
            // Path would be empty: delete the node and leave edit mode.
            const nodeId = edit.nodeId;
            editRef.current = null;
            scissorsRef.current = false;
            setEditingPathId(null);
            documentStore.cancelPreview();
            documentStore.apply({ type: "delete-nodes", nodeIds: [nodeId] });
            setSelection([]);
            syncScene();
            return;
          }

          edit.geometry = next;
          edit.selected = [];
          edit.drag = null;
          edit.changed = true;
          const patch = patchFromLocalGeometry(edit.geometry);
          if (patch) {
            documentStore.preview([{ nodeId: edit.nodeId, patch }]);
          }
          syncScene();
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getScreenPoint = useCallback((event: React.PointerEvent): Vec2 => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const toArtboardLocal = useCallback((screen: Vec2): Vec2 => {
    const artboard = getActiveArtboard(documentStore.document);
    const world = screenToWorld(useEditorStore.getState().camera, screen);
    return { x: world.x - artboard.x, y: world.y - artboard.y };
  }, []);

  const hitHandle = useCallback(
    (screen: Vec2): HandleId | null => {
      const state = useEditorStore.getState();
      if (state.selectedNodeIds.length === 0) {
        return null;
      }
      const frame = selectionFrame(documentStore.document, state.selectedNodeIds);
      if (!frame) {
        return null;
      }
      const center = selectionFrameCenter(frame);

      const artboard = getActiveArtboard(documentStore.document);
      for (const handle of selectionHandles(frame.bounds)) {
        // A tilted frame's handles rotate with it (drawSelection parity).
        const point =
          frame.rotation === 0
            ? handle
            : rotatePoint(handle, center, frame.rotation);
        const handleScreen = worldToScreen(state.camera, {
          x: point.x + artboard.x,
          y: point.y + artboard.y,
        });
        if (
          Math.abs(handleScreen.x - screen.x) <= HANDLE_HIT_RADIUS &&
          Math.abs(handleScreen.y - screen.y) <= HANDLE_HIT_RADIUS
        ) {
          return handle.id;
        }
      }
      return null;
    },
    [],
  );

  /** True when the pointer is over the selection frame's rotate knob. */
  const hitRotateHandle = useCallback((screen: Vec2): boolean => {
    const state = useEditorStore.getState();
    if (state.selectedNodeIds.length === 0) {
      return false;
    }
    const frame = selectionFrame(documentStore.document, state.selectedNodeIds);
    if (!frame) {
      return false;
    }
    const artboard = getActiveArtboard(documentStore.document);
    const knob = rotateHandlePoint(frame, state.camera.zoom);
    const knobScreen = worldToScreen(state.camera, {
      x: knob.x + artboard.x,
      y: knob.y + artboard.y,
    });
    return (
      Math.abs(knobScreen.x - screen.x) <= HANDLE_HIT_RADIUS &&
      Math.abs(knobScreen.y - screen.y) <= HANDLE_HIT_RADIUS
    );
  }, []);

  function finalizePen(closed: boolean) {
    const pen = penRef.current;
    penRef.current = null;

    if (!pen || pen.points.length < 2) {
      syncScene();
      return;
    }

    const geometry: PathGeometry = {
      subpaths: [{ closed, points: pen.points }],
    };
    const patch = patchFromLocalGeometry(geometry);
    if (!patch) {
      syncScene();
      return;
    }

    const node: PathNode = {
      id: createId("node"),
      type: "path",
      name: "Pen path",
      x: patch.x!,
      y: patch.y!,
      width: patch.width!,
      height: patch.height!,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      fill: { type: "solid", color: "#111827" },
      d: patch.d!,
      intrinsicWidth: patch.intrinsicWidth!,
      intrinsicHeight: patch.intrinsicHeight!,
      geometry: patch.geometry!,
    };

    documentStore.apply({
      type: "insert-nodes",
      artboardId: documentStore.document.activeArtboardId,
      nodes: [node],
    });
    setSelection([node.id]);
    setTool("select");
    syncScene();
  }

  function cancelPen() {
    if (penRef.current) {
      penRef.current = null;
      syncScene();
    }
  }

  function startPathEdit(node: PathNode) {
    const geometry = pathNodeLocalGeometry(node);
    if (!geometry) {
      return;
    }
    editRef.current = {
      nodeId: node.id,
      geometry,
      drag: null,
      selected: [],
      changed: false,
    };
    setEditingPathId(node.id);
    setSelection([]);
    syncScene();
  }

  function commitPathEdit() {
    const edit = editRef.current;
    editRef.current = null;
    scissorsRef.current = false;
    setEditingPathId(null);

    // The node may be gone (undo popped its insert mid-edit): committing
    // would push a no-op history entry and wipe the redo stack.
    const nodeExists = edit
      ? Boolean(documentStore.document.nodes[edit.nodeId])
      : false;

    if (edit && edit.changed && nodeExists) {
      const patch = patchFromLocalGeometry(edit.geometry);
      if (patch) {
        documentStore.apply({
          type: "update-nodes",
          updates: [{ nodeId: edit.nodeId, patch }],
        });
      }
    } else {
      documentStore.cancelPreview();
    }

    setSelection(edit && nodeExists ? [edit.nodeId] : []);
    syncScene();
  }

  /** Esc during bezier editing: discard the changes, keep the node. */
  function cancelPathEdit() {
    const edit = editRef.current;
    editRef.current = null;
    scissorsRef.current = false;
    setEditingPathId(null);
    documentStore.cancelPreview();
    setSelection(
      edit && documentStore.document.nodes[edit.nodeId] ? [edit.nodeId] : [],
    );
    syncScene();
  }

  /**
   * Abort an in-flight pointer gesture (move/resize/rotate/marquee/
   * guide/pan) without committing anything — Esc mid-drag, or undo
   * arriving while a gesture is live.
   */
  function cancelActiveDrag() {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    dragRef.current = null;
    if (
      drag.kind === "move" ||
      drag.kind === "resize" ||
      drag.kind === "rotate" ||
      drag.kind === "gradient"
    ) {
      documentStore.cancelPreview();
      setHandleHint(null);
    }
    syncScene(); // drops marquee/guide previews and snap/spacing overlays
  }

  /**
   * Scissors: cut the edited path at an anchor. The whole edit session
   * (any prior anchor edits included) commits together with the cut as
   * one undoable command: a closed subpath just opens in place; an open
   * subpath severs into two nodes (the trailing piece inserts above).
   */
  function commitScissorsCut(subpath: number, index: number) {
    const edit = editRef.current;
    if (!edit) {
      return;
    }
    scissorsRef.current = false;
    setHandleHint(null);

    const result = cutPathAt(edit.geometry, subpath, index);
    if (!result) {
      syncScene();
      return;
    }

    const document = documentStore.document;
    const node = document.nodes[edit.nodeId];
    editRef.current = null;
    setEditingPathId(null);
    documentStore.cancelPreview();
    if (!node || node.type !== "path") {
      setSelection([]);
      syncScene();
      return;
    }

    if (result.kind === "opened") {
      const patch = patchFromLocalGeometry(result.geometry);
      if (patch) {
        documentStore.apply({
          type: "update-nodes",
          updates: [{ nodeId: node.id, patch }],
        });
      }
      setSelection([node.id]);
      syncScene();
      return;
    }

    const firstPatch = patchFromLocalGeometry(result.first);
    const secondPatch = patchFromLocalGeometry(result.second);
    if (!firstPatch || !secondPatch) {
      setSelection([node.id]);
      syncScene();
      return;
    }

    const containerId = findContainerId(document, node.id);
    const artboard = getActiveArtboard(document);
    const container =
      containerId && document.nodes[containerId]?.type === "group"
        ? containerId
        : undefined;
    const siblings = getContainerChildIds(document, containerId ?? artboard.id);

    const piece: PathNode = {
      id: createId("node"),
      type: "path",
      name: `${node.name} cut`,
      x: secondPatch.x!,
      y: secondPatch.y!,
      width: secondPatch.width!,
      height: secondPatch.height!,
      rotation: 0,
      opacity: node.opacity,
      visible: true,
      locked: false,
      fill: structuredClone(node.fill),
      ...(node.stroke ? { stroke: { ...node.stroke } } : {}),
      d: secondPatch.d!,
      intrinsicWidth: secondPatch.intrinsicWidth!,
      intrinsicHeight: secondPatch.intrinsicHeight!,
      geometry: secondPatch.geometry!,
    };

    documentStore.apply({
      type: "batch",
      label: "Cut path",
      commands: [
        { type: "update-nodes", updates: [{ nodeId: node.id, patch: firstPatch }] },
        {
          type: "insert-nodes",
          artboardId: artboard.id,
          ...(container ? { containerId: container } : {}),
          nodes: [piece],
          index: siblings.indexOf(node.id) + 1,
        },
      ],
    });
    setSelection([node.id, piece.id]);
    syncScene();
  }

  /** ⌘J in edit mode: join the two selected endpoint anchors. */
  function joinAnchorsInEdit() {
    const edit = editRef.current;
    if (!edit) {
      return;
    }
    if (edit.selected.length !== 2) {
      setHandleHint("Join: ⇧-click two endpoint anchors first");
      return;
    }
    const joined = joinAnchors(edit.geometry, edit.selected[0]!, edit.selected[1]!);
    if (!joined) {
      setHandleHint("Join: both anchors must be open-path endpoints");
      return;
    }
    edit.geometry = joined;
    edit.selected = []; // indices may have shifted
    edit.drag = null;
    edit.changed = true;
    const patch = patchFromLocalGeometry(edit.geometry);
    if (patch) {
      documentStore.preview([{ nodeId: edit.nodeId, patch }]);
    }
    setHandleHint(null);
    syncScene();
  }

  /** ⌥⌘J in edit mode: average the selected anchors (⇧ = y only, ⌃ = x only). */
  function averageAnchorsInEdit(axis: "horizontal" | "vertical" | "both") {
    const edit = editRef.current;
    if (!edit) {
      return;
    }
    if (edit.selected.length < 2) {
      setHandleHint("Average: ⇧-click two or more anchors first");
      return;
    }
    const averaged = averageAnchors(edit.geometry, edit.selected, axis);
    if (!averaged) {
      return;
    }
    edit.geometry = averaged;
    edit.drag = null;
    edit.changed = true;
    const patch = patchFromLocalGeometry(edit.geometry);
    if (patch) {
      documentStore.preview([{ nodeId: edit.nodeId, patch }]);
    }
    setHandleHint(null);
    syncScene();
  }

  function hitEditTarget(
    screen: Vec2,
  ): { subpath: number; index: number; part: "anchor" | "in" | "out" } | null {
    const edit = editRef.current;
    if (!edit) {
      return null;
    }

    const artboard = getActiveArtboard(documentStore.document);
    const camera = useEditorStore.getState().camera;
    const toScreen = (p: Vec2) =>
      worldToScreen(camera, { x: p.x + artboard.x, y: p.y + artboard.y });
    const within = (p: Vec2) => {
      const s = toScreen(p);
      return (
        Math.abs(s.x - screen.x) <= HANDLE_HIT_RADIUS &&
        Math.abs(s.y - screen.y) <= HANDLE_HIT_RADIUS
      );
    };

    for (const [si, subpath] of edit.geometry.subpaths.entries()) {
      for (const [pi, point] of subpath.points.entries()) {
        // Handles first so they stay grabbable near their anchor.
        if (point.handleIn && within(point.handleIn)) {
          return { subpath: si, index: pi, part: "in" };
        }
        if (point.handleOut && within(point.handleOut)) {
          return { subpath: si, index: pi, part: "out" };
        }
        if (within(point)) {
          return { subpath: si, index: pi, part: "anchor" };
        }
      }
    }

    return null;
  }

  function commitGuideDrag() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.kind !== "guide") {
      return;
    }

    const artboard = getActiveArtboard(documentStore.document);
    const guides = {
      v: [...(artboard.guides?.v ?? [])],
      h: [...(artboard.guides?.h ?? [])],
    };
    const list = drag.axis === "v" ? guides.v : guides.h;
    const limit = drag.axis === "v" ? artboard.width : artboard.height;
    const inRange = drag.value >= 0 && drag.value <= limit;

    if (drag.index === -1) {
      if (inRange) {
        list.push(Math.round(drag.value * 2) / 2);
      }
    } else if (inRange) {
      list[drag.index] = Math.round(drag.value * 2) / 2;
    } else {
      list.splice(drag.index, 1); // dragged off the artboard = delete
    }

    documentStore.apply({
      type: "update-artboard",
      artboardId: artboard.id,
      patch: { guides },
    });
    syncScene();
  }

  function startGuideFromRuler(axis: "v" | "h") {
    return (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      const canvasRect = canvasRef.current!.getBoundingClientRect();
      const screen = {
        x: event.clientX - canvasRect.left,
        y: event.clientY - canvasRect.top,
      };
      const local = toArtboardLocal(screen);
      dragRef.current = {
        kind: "guide",
        axis,
        index: -1,
        value: axis === "v" ? local.x : local.y,
      };
      syncScene();
    };
  }

  function moveGuideFromRuler(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.kind !== "guide") {
      return;
    }
    const canvasRect = canvasRef.current!.getBoundingClientRect();
    const local = toArtboardLocal({
      x: event.clientX - canvasRect.left,
      y: event.clientY - canvasRect.top,
    });
    drag.value = drag.axis === "v" ? local.x : local.y;
    syncScene();
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!canvas || !renderer) {
      return;
    }

    canvas.setPointerCapture(event.pointerId);
    const screen = getScreenPoint(event);

    // Middle mouse or held space pans.
    if (event.button === 1 || spaceRef.current) {
      dragRef.current = { kind: "pan", last: screen };
      return;
    }

    // Any canvas press while inline-editing text commits the edit.
    if (editingTextRef.current) {
      return;
    }

    const state = useEditorStore.getState();

    // Bezier edit mode captures all pointer input.
    if (editRef.current) {
      const edit = editRef.current;
      const target = hitEditTarget(screen);

      // Scissors sub-mode: the click cuts at an anchor or segment point.
      if (scissorsRef.current) {
        if (target && target.part === "anchor") {
          commitScissorsCut(target.subpath, target.index);
          return;
        }
        const local = toArtboardLocal(screen);
        const segment = findSegmentNear(
          edit.geometry,
          local,
          6 / state.camera.zoom,
        );
        if (segment) {
          const inserted = insertAnchor(
            edit.geometry,
            segment.subpath,
            segment.index,
            segment.t,
          );
          if (inserted) {
            edit.geometry = inserted.geometry;
            commitScissorsCut(segment.subpath, inserted.index);
            return;
          }
        }
        scissorsRef.current = false; // clicked empty space: disarm
        setHandleHint(null);
        syncScene();
        return;
      }

      if (target) {
        // ⌥ on an anchor = convert-anchor: a click retracts a smooth
        // point to a corner (or, on a corner, pulls smooth handles back
        // out via the heuristic on release); an ⌥-drag grows symmetric
        // handles out of the anchor, pen-style.
        if (event.altKey && target.part === "anchor") {
          const point =
            edit.geometry.subpaths[target.subpath]?.points[target.index];
          if (!point) {
            return;
          }
          const hadHandles = Boolean(point.handleIn || point.handleOut);
          if (hadHandles) {
            const next = setAnchorCorner(
              edit.geometry,
              target.subpath,
              target.index,
            );
            if (next) {
              edit.geometry = next;
              edit.changed = true;
              const patch = patchFromLocalGeometry(edit.geometry);
              if (patch) {
                documentStore.preview([{ nodeId: edit.nodeId, patch }]);
              }
            }
          }
          edit.drag = {
            subpath: target.subpath,
            index: target.index,
            part: "pull",
            pull: {
              hadHandles,
              downLocal: toArtboardLocal(screen),
              moved: false,
            },
          };
          edit.selected = [
            { subpath: target.subpath, index: target.index },
          ];
          syncScene();
          return;
        }

        edit.drag = target;
        if (target.part === "anchor") {
          const ref = { subpath: target.subpath, index: target.index };
          const already = edit.selected.some(
            (item) => item.subpath === ref.subpath && item.index === ref.index,
          );
          // ⇧ builds a multi-anchor selection (join/average/delete).
          edit.selected = event.shiftKey
            ? already
              ? edit.selected.filter(
                  (item) =>
                    item.subpath !== ref.subpath || item.index !== ref.index,
                )
              : [...edit.selected, ref]
            : already
              ? edit.selected
              : [ref];
        }
        syncScene();
        return;
      }

      // Clicking a segment inserts an anchor there.
      const local = toArtboardLocal(screen);
      const zoom = state.camera.zoom;
      const segment = findSegmentNear(edit.geometry, local, 6 / zoom);
      if (segment) {
        const inserted = insertAnchor(
          edit.geometry,
          segment.subpath,
          segment.index,
          segment.t,
        );
        if (inserted) {
          edit.geometry = inserted.geometry;
          edit.selected = [{ subpath: segment.subpath, index: inserted.index }];
          edit.drag = {
            subpath: segment.subpath,
            index: inserted.index,
            part: "anchor",
          };
          edit.changed = true;
          const patch = patchFromLocalGeometry(edit.geometry);
          if (patch) {
            documentStore.preview([{ nodeId: edit.nodeId, patch }]);
          }
          syncScene();
        }
        return;
      }

      commitPathEdit();
      return;
    }

    // Shape Builder captures clicks: merge or delete the hit region.
    if (state.tool === "shapeBuilder") {
      const sb = sbRef.current;
      if (sb) {
        const region = hitShapeBuilderRegion(sb, toArtboardLocal(screen));
        if (region) {
          if (event.altKey) {
            region.state = "deleted";
            region.mergeOrder = -1;
          } else {
            region.state = "merged";
            region.mergeOrder = sb.nextMergeOrder;
            sb.nextMergeOrder += 1;
          }
          syncScene();
        }
      }
      return;
    }

    if (state.tool === "pen") {
      let local = toArtboardLocal(screen);

      // Snap new anchors to guides/nodes/artboard (Alt disables).
      if (!event.altKey) {
        const snap = computeSnap(
          { x: local.x, y: local.y, width: 0, height: 0 },
          collectSnapTargets(new Set()),
          6 / state.camera.zoom,
        );
        local = { x: local.x + snap.dx, y: local.y + snap.dy };
      }

      const pen = penRef.current;

      // Clicking the first anchor closes the path.
      if (pen && pen.points.length >= 2) {
        const first = pen.points[0]!;
        const zoom = state.camera.zoom;
        if (
          Math.hypot(first.x - local.x, first.y - local.y) <=
          HANDLE_HIT_RADIUS / zoom
        ) {
          finalizePen(true);
          return;
        }
      }

      if (!pen) {
        penRef.current = {
          points: [{ x: local.x, y: local.y }],
          dragging: true,
          cursor: null,
        };
      } else {
        pen.points.push({ x: local.x, y: local.y });
        pen.dragging = true;
      }
      syncScene();
      return;
    }

    // Eyedropper: apply the clicked node's paint to the selection.
    if (state.tool === "eyedropper") {
      const hit = renderer.hitTest(screen);
      if (hit && state.selectedNodeIds.length > 0) {
        documentStore.apply({
          type: "update-nodes",
          updates: collectLeafNodeIds(
            documentStore.document,
            state.selectedNodeIds,
          )
            .filter((id) => id !== hit.id)
            .map((nodeId) => ({
              nodeId,
              patch: {
                fill: structuredClone(hit.fill),
                stroke: hit.stroke ? { ...hit.stroke } : undefined,
              },
            })),
        });
      }
      setTool("select");
      return;
    }

    // Gradient annotator (G): grab a handle of the selected node's
    // gradient, or press anywhere to define a new line/spread by drag.
    if (state.tool === "gradient") {
      const doc = documentStore.document;
      let node =
        state.selectedNodeIds.length === 1
          ? doc.nodes[state.selectedNodeIds[0]!]
          : undefined;
      if (!node || node.type === "group") {
        const hit = renderer.hitTest(screen);
        if (!hit) {
          return;
        }
        setSelection([hit.id]);
        node = hit;
      }
      const artboard = getActiveArtboard(doc);
      for (const handle of gradientHandlePoints(node)) {
        const handleScreen = worldToScreen(state.camera, {
          x: handle.x + artboard.x,
          y: handle.y + artboard.y,
        });
        if (
          Math.abs(handleScreen.x - screen.x) <= HANDLE_HIT_RADIUS &&
          Math.abs(handleScreen.y - screen.y) <= HANDLE_HIT_RADIUS
        ) {
          dragRef.current = {
            kind: "gradient",
            nodeId: node.id,
            part: handle.part,
            paint: node.fill,
            startFrac: localToFraction(node, toArtboardLocal(screen)),
            moved: false,
          };
          return;
        }
      }
      dragRef.current = {
        kind: "gradient",
        nodeId: node.id,
        part: "define",
        paint: node.fill,
        startFrac: localToFraction(node, toArtboardLocal(screen)),
        moved: false,
      };
      return;
    }

    // Shape tools drag-to-draw; a plain click (no movement) falls back to
    // placing the default size on pointer-up.
    if (SHAPE_DRAW_TOOLS.has(state.tool)) {
      const local = toArtboardLocal(screen);
      dragRef.current = {
        kind: "draw",
        tool: state.tool,
        ghostId: createId("node"),
        start: local,
        current: local,
        shift: event.shiftKey,
        moved: false,
      };
      return;
    }

    if (state.tool !== "select") {
      const local = toArtboardLocal(screen);
      const node = makeNodeForTool(state.tool, local);
      if (node) {
        documentStore.apply({
          type: "insert-nodes",
          artboardId: documentStore.document.activeArtboardId,
          nodes: [node],
        });
        setSelection([node.id]);
        setTool("select");
      }
      return;
    }

    // Existing ruler guides are grabbable near the line.
    {
      const artboard = getActiveArtboard(documentStore.document);
      const local = toArtboardLocal(screen);
      const tolerance = 5 / state.camera.zoom;
      const vIndex = (artboard.guides?.v ?? []).findIndex(
        (x) => Math.abs(x - local.x) <= tolerance,
      );
      const hIndex = (artboard.guides?.h ?? []).findIndex(
        (y) => Math.abs(y - local.y) <= tolerance,
      );
      if (vIndex !== -1 || hIndex !== -1) {
        dragRef.current =
          vIndex !== -1
            ? { kind: "guide", axis: "v", index: vIndex, value: local.x }
            : { kind: "guide", axis: "h", index: hIndex, value: local.y };
        return;
      }
    }

    // Rotate handle — outside the frame, checked before everything else.
    if (hitRotateHandle(screen)) {
      const frame = selectionFrame(
        documentStore.document,
        state.selectedNodeIds,
      );
      if (frame) {
        const pivot = selectionFrameCenter(frame);
        const snapshots = snapshotNodes(state.selectedNodeIds);
        dragRef.current = {
          kind: "rotate",
          pivot,
          startPointerAngle: pointerAngle(toArtboardLocal(screen), pivot),
          baseRotation: snapshots.values().next().value?.rotation ?? 0,
          delta: 0,
          snapshots,
          patches: [],
          moved: false,
        };
      }
      return;
    }

    // Resize handle next — takes priority over node hits.
    const handle = hitHandle(screen);
    if (handle) {
      const frame = selectionFrame(
        documentStore.document,
        state.selectedNodeIds,
      );
      const snapshots = snapshotNodes(state.selectedNodeIds);
      if (frame) {
        dragRef.current = {
          kind: "resize",
          handle,
          startLocal: toArtboardLocal(screen),
          startBounds: frame.bounds,
          frameRotation: frame.rotation,
          lastBounds: frame.bounds,
          snapshots,
          patches: [],
          moved: false,
          snapTargets: collectSnapTargets(
            new Set([
              ...state.selectedNodeIds,
              ...collectLeafNodeIds(
                documentStore.document,
                state.selectedNodeIds,
              ),
            ]),
          ),
          guides: [],
          spacingGaps: [],
          distanceLabels: [],
        };
      }
      return;
    }

    // Artboard name label: a click activates that board, a drag
    // repositions it on the shared canvas (checked before node hits —
    // the label is chrome floating above everything).
    const labelBoardId = renderer.hitArtboardLabel(screen);
    if (labelBoardId) {
      const doc = documentStore.document;
      const board = doc.artboards.find((item) => item.id === labelBoardId);
      if (board) {
        dragRef.current = {
          kind: "artboard",
          artboardId: board.id,
          startWorld: screenToWorld(state.camera, screen),
          origin: { x: board.x, y: board.y },
          current: { x: board.x, y: board.y },
          snapTargets: doc.artboards
            .filter((item) => item.id !== board.id)
            .map((item) => ({
              x: item.x,
              y: item.y,
              width: item.width,
              height: item.height,
            })),
          moved: false,
        };
        return;
      }
    }

    const hit = renderer.hitTest(screen);

    if (!hit) {
      // Clicking inside another artboard's area makes it the active one —
      // you work "in" the board you clicked, Illustrator-style.
      const bodyBoardId = renderer.hitArtboardBody(screen);
      if (
        bodyBoardId &&
        bodyBoardId !== documentStore.document.activeArtboardId
      ) {
        documentStore.apply({
          type: "set-active-artboard",
          artboardId: bodyBoardId,
        });
        setSelection([]);
        syncScene();
        return;
      }

      const local = toArtboardLocal(screen);
      if (!event.shiftKey) {
        setSelection([]);
      }
      dragRef.current = { kind: "marquee", startLocal: local, current: null };
      syncScene();
      return;
    }

    // Resolve the hit leaf to its selection unit: outermost group at top
    // level, direct child inside the active group scope. ⌘-click selects
    // through to the leaf itself.
    const { unitId, scopeId } = resolveUnit(
      documentStore.document,
      hit.id,
      state.activeGroupId,
      event.metaKey,
    );
    if (scopeId !== state.activeGroupId) {
      state.setActiveGroupId(scopeId); // clicked outside the scoped subtree
    }
    const targetIds = [unitId];

    const alreadySelected = targetIds.every((id) =>
      state.selectedNodeIds.includes(id),
    );
    let nextSelection = event.shiftKey
      ? alreadySelected
        ? state.selectedNodeIds.filter((id) => !targetIds.includes(id))
        : [...new Set([...state.selectedNodeIds, ...targetIds])]
      : alreadySelected
        ? state.selectedNodeIds
        : targetIds;

    // Alt-drag duplicates the selection (whole subtrees) and drags the copies.
    let copied = false;
    if (event.altKey && !event.shiftKey) {
      const document = documentStore.document;
      const artboard = getActiveArtboard(document);
      const { nodes: clones, rootIds } = cloneUnits(document, nextSelection);
      if (clones.length > 0) {
        documentStore.apply({
          type: "insert-nodes",
          artboardId: artboard.id,
          // Duplicating inside a group scope keeps the copies in it.
          ...(state.activeGroupId ? { containerId: state.activeGroupId } : {}),
          nodes: clones,
        });
        nextSelection = rootIds;
        copied = true;
      }
    }

    setSelection(nextSelection);
    const excluded = new Set([
      ...nextSelection,
      ...collectLeafNodeIds(documentStore.document, nextSelection),
    ]);
    dragRef.current = {
      kind: "move",
      startLocal: toArtboardLocal(screen),
      snapshots: snapshotNodes(nextSelection),
      patches: [],
      moved: false,
      copied,
      reclickedUnitId:
        alreadySelected && !event.shiftKey && !event.altKey ? unitId : null,
      appliedDx: 0,
      appliedDy: 0,
      snapTargets: collectSnapTargets(excluded),
      guides: [],
      spacingGaps: [],
      distanceLabels: [],
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const screen = getScreenPoint(event);

    // Panning wins over every mode — space/middle-drag must work during
    // pen and bezier-edit sessions too, and processing it first keeps the
    // drag from being orphaned by those branches' early returns.
    const panDrag = dragRef.current;
    if (panDrag?.kind === "pan") {
      const camera = useEditorStore.getState().camera;
      setCamera(
        panBy(camera, {
          x: screen.x - panDrag.last.x,
          y: screen.y - panDrag.last.y,
        }),
      );
      panDrag.last = screen;
      return;
    }

    // Bezier edit mode.
    const edit = editRef.current;
    if (edit) {
      if (!edit.drag) {
        return;
      }
      const local = toArtboardLocal(screen);
      const point = edit.geometry.subpaths[edit.drag.subpath]?.points[
        edit.drag.index
      ];
      if (!point) {
        return;
      }

      if (edit.drag.part === "anchor") {
        const dx = local.x - point.x;
        const dy = local.y - point.y;
        point.x = local.x;
        point.y = local.y;
        if (point.handleIn) {
          point.handleIn = {
            x: point.handleIn.x + dx,
            y: point.handleIn.y + dy,
          };
        }
        if (point.handleOut) {
          point.handleOut = {
            x: point.handleOut.x + dx,
            y: point.handleOut.y + dy,
          };
        }
      } else if (edit.drag.part === "pull") {
        // Convert-anchor ⌥-drag: symmetric handles grow out of the
        // anchor regardless of ⌥ (that's what armed the gesture).
        const pull = edit.drag.pull;
        if (
          pull &&
          !pull.moved &&
          Math.hypot(local.x - pull.downLocal.x, local.y - pull.downLocal.y) <=
            2 / useEditorStore.getState().camera.zoom
        ) {
          return; // ignore jitter so a plain ⌥-click stays a click
        }
        if (pull) {
          pull.moved = true;
        }
        point.handleOut = { x: local.x, y: local.y };
        point.handleIn = {
          x: point.x * 2 - local.x,
          y: point.y * 2 - local.y,
        };
        setHandleHint("Convert anchor: symmetric handles");
      } else if (edit.drag.part === "in") {
        point.handleIn = { x: local.x, y: local.y };
        // Mirrored (symmetric) by default; Alt breaks the pair apart.
        if (!event.altKey && point.handleOut) {
          point.handleOut = {
            x: point.x * 2 - local.x,
            y: point.y * 2 - local.y,
          };
        }
      } else {
        point.handleOut = { x: local.x, y: local.y };
        if (!event.altKey && point.handleIn) {
          point.handleIn = {
            x: point.x * 2 - local.x,
            y: point.y * 2 - local.y,
          };
        }
      }

      if (edit.drag.part === "in" || edit.drag.part === "out") {
        setHandleHint(
          event.altKey
            ? "Handles: broken (⌥)"
            : "Handles: mirrored — hold ⌥ to break",
        );
      }

      edit.changed = true;
      const patch = patchFromLocalGeometry(edit.geometry);
      if (patch) {
        documentStore.preview([{ nodeId: edit.nodeId, patch }]);
      }
      syncScene();
      return;
    }

    // Pen tool.
    const state = useEditorStore.getState();
    if (state.tool === "pen") {
      const pen = penRef.current;
      if (!pen) {
        return;
      }
      const local = toArtboardLocal(screen);

      if (pen.dragging && event.buttons > 0) {
        // Drag out symmetric handles for the last anchor; Alt breaks the
        // mirror and moves handleOut alone (same modifier as edit mode).
        const anchor = pen.points[pen.points.length - 1]!;
        anchor.handleOut = { x: local.x, y: local.y };
        if (!event.altKey) {
          anchor.handleIn = {
            x: anchor.x * 2 - local.x,
            y: anchor.y * 2 - local.y,
          };
        }
        setHandleHint(
          event.altKey
            ? "Handles: broken (⌥)"
            : "Handles: mirrored — hold ⌥ to break",
        );
      } else {
        pen.cursor = local;
      }
      syncScene();
      return;
    }

    // Shape Builder hover: track the region under the cursor (pan via
    // space/middle-drag falls through to the drag handling below).
    if (state.tool === "shapeBuilder" && !dragRef.current) {
      const sb = sbRef.current;
      if (sb) {
        const region = hitShapeBuilderRegion(sb, toArtboardLocal(screen));
        const nextId = region ? region.id : null;
        if (sb.hoveredId !== nextId) {
          sb.hoveredId = nextId;
          syncScene();
        }
      }
      return;
    }

    const drag = dragRef.current;
    if (!drag) {
      // Idle hover tracking (select tool only); outlines the unit the
      // click would select (group at top level, child inside scope).
      if (state.tool === "select") {
        const hit = rendererRef.current?.hitTest(screen) ?? null;
        const nextId = hit
          ? resolveUnit(
              documentStore.document,
              hit.id,
              state.activeGroupId,
              event.metaKey,
            ).unitId
          : null;

        // ⌥-hover measures between the selection and the hovered unit.
        let nextMeasure: MeasureSegment[] | null = null;
        if (
          event.altKey &&
          nextId &&
          state.selectedNodeIds.length > 0 &&
          !state.selectedNodeIds.includes(nextId)
        ) {
          const document = documentStore.document;
          const selection = selectionUnitBounds(
            document,
            state.selectedNodeIds,
          );
          const hovered = unitBounds(document, nextId);
          if (selection && hovered) {
            nextMeasure = measureDistances(selection, [hovered]);
          }
        }
        const measureChanged =
          JSON.stringify(nextMeasure) !== JSON.stringify(measureRef.current);

        if (hoverRef.current !== nextId || measureChanged) {
          hoverRef.current = nextId;
          measureRef.current = nextMeasure;
          syncScene();
        }
      } else if (hoverRef.current || measureRef.current) {
        hoverRef.current = null;
        measureRef.current = null;
        syncScene();
      }
      return;
    }

    if (hoverRef.current) {
      hoverRef.current = null;
    }

    if (drag.kind === "pan") {
      return; // handled at the top of this handler
    }

    if (drag.kind === "guide") {
      const local = toArtboardLocal(screen);
      drag.value = drag.axis === "v" ? local.x : local.y;
      syncScene();
      return;
    }

    // Artboard reposition (label drag) works in world space and snaps the
    // board's edges to the other boards' edges (Alt disables).
    if (drag.kind === "artboard") {
      const zoom = useEditorStore.getState().camera.zoom;
      const world = screenToWorld(useEditorStore.getState().camera, screen);
      const dx = world.x - drag.startWorld.x;
      const dy = world.y - drag.startWorld.y;
      const board = documentStore.document.artboards.find(
        (item) => item.id === drag.artboardId,
      );
      if (!board) {
        dragRef.current = null;
        return;
      }
      const raw = {
        x: drag.origin.x + dx,
        y: drag.origin.y + dy,
        width: board.width,
        height: board.height,
      };
      let snapDx = 0;
      let snapDy = 0;
      if (!event.altKey) {
        const snap = computeSnap(raw, drag.snapTargets, 6 / zoom);
        snapDx = snap.dx;
        snapDy = snap.dy;
      }
      drag.current = { x: raw.x + snapDx, y: raw.y + snapDy };
      drag.moved = drag.moved || Math.hypot(dx, dy) > 3 / zoom;
      syncScene();
      return;
    }

    const local = toArtboardLocal(screen);

    if (drag.kind === "draw") {
      drag.current = local;
      drag.shift = event.shiftKey;
      if (!drag.moved) {
        const zoom = useEditorStore.getState().camera.zoom;
        drag.moved =
          Math.hypot(local.x - drag.start.x, local.y - drag.start.y) >
          3 / zoom;
      }
      syncScene();
      return;
    }

    if (drag.kind === "gradient") {
      const node = documentStore.document.nodes[drag.nodeId];
      if (!node || node.type === "group") {
        dragRef.current = null;
        return;
      }
      const frac = localToFraction(node, local);
      drag.paint =
        drag.part === "define"
          ? gradientDefinePaint(node, drag.paint, drag.startFrac, frac)
          : gradientDragPaint(node, drag.paint, drag.part, frac);
      drag.moved = true;
      documentStore.preview([
        { nodeId: node.id, patch: { fill: drag.paint } },
      ]);
      syncScene();
      return;
    }

    if (drag.kind === "marquee") {
      drag.current = {
        x: Math.min(drag.startLocal.x, local.x),
        y: Math.min(drag.startLocal.y, local.y),
        width: Math.abs(local.x - drag.startLocal.x),
        height: Math.abs(local.y - drag.startLocal.y),
      };
      // Marquee is drawn in world space; convert on sync.
      syncSceneWithMarquee(drag.current);
      return;
    }

    if (drag.kind === "rotate") {
      let delta = pointerAngle(local, drag.pivot) - drag.startPointerAngle;
      // ⇧ snaps the RESULTING rotation to 15° multiples.
      if (event.shiftKey) {
        delta =
          Math.round((drag.baseRotation + delta) / 15) * 15 -
          drag.baseRotation;
      }
      drag.delta = delta;
      drag.patches = [...drag.snapshots.entries()].map(([nodeId, snap]) => {
        const center = rotatePoint(
          { x: snap.x + snap.width / 2, y: snap.y + snap.height / 2 },
          drag.pivot,
          delta,
        );
        return {
          nodeId,
          patch: {
            x: center.x - snap.width / 2,
            y: center.y - snap.height / 2,
            rotation: normalizeAngle(snap.rotation + delta),
          },
        };
      });
      drag.moved = drag.moved || delta !== 0;
      setHandleHint(
        `∠ ${Math.round(normalizeAngle(drag.baseRotation + delta))}°${
          event.shiftKey ? "" : " — ⇧ snaps to 15°"
        }`,
      );
      documentStore.preview(drag.patches);
      syncScene();
      return;
    }

    const dx = local.x - drag.startLocal.x;
    const dy = local.y - drag.startLocal.y;

    if (drag.kind === "move") {
      let snapDx = 0;
      let snapDy = 0;
      drag.guides = [];
      drag.spacingGaps = [];
      drag.distanceLabels = [];

      // Alt disables snapping, Illustrator-style.
      if (!event.altKey) {
        const startBounds = snapshotBounds(drag.snapshots);
        if (startBounds) {
          const zoom = useEditorStore.getState().camera.zoom;
          const threshold = 6 / zoom;
          const raw = {
            ...startBounds,
            x: startBounds.x + dx,
            y: startBounds.y + dy,
          };
          const snap = computeSnap(raw, drag.snapTargets, threshold);
          snapDx = snap.dx;
          snapDy = snap.dy;
          let guides = snap.guides;

          // Equal-spacing candidates compete with edge snapping per
          // axis; the smaller correction wins and drops that axis's
          // edge guides (the alignment they claim no longer holds).
          for (const axis of ["x", "y"] as const) {
            const spacing = computeSpacingSnap(
              raw,
              drag.snapTargets,
              axis,
              threshold,
            );
            if (!spacing) {
              continue;
            }
            const edgeDelta = axis === "x" ? snapDx : snapDy;
            const hasEdge = guides.some((guide) => guide.axis === axis);
            if (!hasEdge || Math.abs(spacing.delta) < Math.abs(edgeDelta)) {
              if (axis === "x") {
                snapDx = spacing.delta;
              } else {
                snapDy = spacing.delta;
              }
              guides = guides.filter((guide) => guide.axis !== axis);
              drag.spacingGaps.push(...spacing.gaps);
            }
          }
          drag.guides = guides;

          // Distance readouts appear once anything snapped.
          if (guides.length > 0 || drag.spacingGaps.length > 0) {
            drag.distanceLabels = measureDistances(
              { ...raw, x: raw.x + snapDx, y: raw.y + snapDy },
              drag.snapTargets,
            );
          }
        }
      }

      drag.patches = [...drag.snapshots.entries()].map(([nodeId, snap]) => ({
        nodeId,
        patch: { x: snap.x + dx + snapDx, y: snap.y + dy + snapDy },
      }));
      drag.moved = drag.moved || dx !== 0 || dy !== 0;
      drag.appliedDx = dx + snapDx;
      drag.appliedDy = dy + snapDy;
      documentStore.preview(drag.patches);
      syncScene();
      return;
    }

    // Resize. A tilted frame (single rotated leaf) resizes in the
    // node's local space: the pointer delta rotates into that space,
    // the box scales axis-aligned there, and a final translation keeps
    // the anchored corner fixed in world space (the box rotates about
    // its own centre, which the resize moved).
    const rotated = drag.frameRotation !== 0;
    const localDelta = rotated
      ? rotateVec({ x: dx, y: dy }, -drag.frameRotation)
      : { x: dx, y: dy };
    let next = resizeBounds(
      drag.startBounds,
      drag.handle,
      localDelta.x,
      localDelta.y,
    );
    drag.guides = [];
    drag.spacingGaps = [];
    drag.distanceLabels = [];

    // Shift on a corner keeps the aspect ratio (dominant axis wins).
    const isCornerHandle = drag.handle.length === 2;
    if (event.shiftKey && isCornerHandle) {
      const sxRaw = next.width / drag.startBounds.width;
      const syRaw = next.height / drag.startBounds.height;
      const s = Math.abs(sxRaw - 1) > Math.abs(syRaw - 1) ? sxRaw : syRaw;
      const width = Math.max(8, drag.startBounds.width * s);
      const height = Math.max(8, drag.startBounds.height * s);
      next = {
        x: drag.handle.includes("w")
          ? drag.startBounds.x + drag.startBounds.width - width
          : drag.startBounds.x,
        y: drag.handle.includes("n")
          ? drag.startBounds.y + drag.startBounds.height - height
          : drag.startBounds.y,
        width,
        height,
      };
    }

    // Snap the dragged edges (Alt disables; skipped while constraining
    // and on tilted frames, whose edges are not axis-aligned).
    if (!event.altKey && !(event.shiftKey && isCornerHandle) && !rotated) {
      const zoom = useEditorStore.getState().camera.zoom;
      const threshold = 6 / zoom;
      const extentY = { start: next.y, end: next.y + next.height };
      const extentX = { start: next.x, end: next.x + next.width };

      if (drag.handle.includes("w")) {
        const snap = snapValue(next.x, extentY, drag.snapTargets, "x", threshold);
        if (snap.guide) {
          next = {
            ...next,
            x: next.x + snap.delta,
            width: Math.max(8, next.width - snap.delta),
          };
          drag.guides.push(snap.guide);
        }
      } else if (drag.handle.includes("e")) {
        const snap = snapValue(
          next.x + next.width,
          extentY,
          drag.snapTargets,
          "x",
          threshold,
        );
        if (snap.guide) {
          next = { ...next, width: Math.max(8, next.width + snap.delta) };
          drag.guides.push(snap.guide);
        }
      }

      if (drag.handle.includes("n")) {
        const snap = snapValue(next.y, extentX, drag.snapTargets, "y", threshold);
        if (snap.guide) {
          next = {
            ...next,
            y: next.y + snap.delta,
            height: Math.max(8, next.height - snap.delta),
          };
          drag.guides.push(snap.guide);
        }
      } else if (drag.handle.includes("s")) {
        const snap = snapValue(
          next.y + next.height,
          extentX,
          drag.snapTargets,
          "y",
          threshold,
        );
        if (snap.guide) {
          next = { ...next, height: Math.max(8, next.height + snap.delta) };
          drag.guides.push(snap.guide);
        }
      }
    }

    // Distance readouts for the snapped bounds.
    if (drag.guides.length > 0) {
      drag.distanceLabels = measureDistances(next, drag.snapTargets);
    }

    if (rotated) {
      // Keep the anchored corner still: the stored box's centre moved by
      // d, but the node renders rotated about that centre — translate by
      // R(d) − d so the rotation pivot shift cancels at the anchor.
      const d = {
        x:
          next.x + next.width / 2 - (drag.startBounds.x + drag.startBounds.width / 2),
        y:
          next.y + next.height / 2 - (drag.startBounds.y + drag.startBounds.height / 2),
      };
      const spun = rotateVec(d, drag.frameRotation);
      next = { ...next, x: next.x + spun.x - d.x, y: next.y + spun.y - d.y };
    }
    drag.lastBounds = next;

    const sx = next.width / drag.startBounds.width;
    const sy = next.height / drag.startBounds.height;
    const isCorner = drag.handle.length === 2;

    drag.patches = [...drag.snapshots.entries()].map(([nodeId, snap]) => {
      const patch: NodePatch = {
        x: next.x + (snap.x - drag.startBounds.x) * sx,
        y: next.y + (snap.y - drag.startBounds.y) * sy,
        width: Math.max(4, snap.width * sx),
        height: Math.max(4, snap.height * sy),
      };
      if (snap.fontSize !== undefined && isCorner) {
        patch.fontSize = Math.max(6, snap.fontSize * sy);
      }
      return { nodeId, patch };
    });
    drag.moved = true;
    documentStore.preview(drag.patches);
    syncScene();
  }

  function syncSceneWithMarquee(marquee: Bounds) {
    const renderer = rendererRef.current;
    if (!renderer) {
      return;
    }
    const artboard = getActiveArtboard(documentStore.document);
    const state = useEditorStore.getState();
    renderer.setScene({
      document: documentStore.document,
      camera: state.camera,
      selectedNodeIds: state.selectedNodeIds,
      marquee: {
        ...marquee,
        x: marquee.x + artboard.x,
        y: marquee.y + artboard.y,
      },
    });
  }

  function handlePointerUp() {
    // Pan first: the edit/pen early-returns below must never orphan a
    // pan drag (a stale one would pan the camera on buttonless hover).
    if (dragRef.current?.kind === "pan") {
      dragRef.current = null;
      return;
    }

    if (dragRef.current?.kind === "guide") {
      commitGuideDrag();
      return;
    }

    const edit = editRef.current;
    if (edit) {
      const drag = edit.drag;
      // A plain ⌥-click (no drag) on a handle-less anchor converts it
      // to smooth; ⌥-click on a smooth one already retracted on press.
      if (
        drag?.part === "pull" &&
        drag.pull &&
        !drag.pull.moved &&
        !drag.pull.hadHandles
      ) {
        const next = setAnchorSmooth(edit.geometry, drag.subpath, drag.index);
        if (next) {
          edit.geometry = next;
          edit.changed = true;
          const patch = patchFromLocalGeometry(edit.geometry);
          if (patch) {
            documentStore.preview([{ nodeId: edit.nodeId, patch }]);
          }
          syncScene();
        }
      }
      edit.drag = null;
      setHandleHint(null);
      return;
    }

    const pen = penRef.current;
    if (pen) {
      pen.dragging = false;
      setHandleHint(null);
      return;
    }

    const drag = dragRef.current;
    dragRef.current = null;

    if (!drag) {
      return;
    }

    if (drag.kind === "artboard") {
      if (drag.moved) {
        // One history entry; update-artboard's inverse restores x/y exactly.
        documentStore.apply({
          type: "update-artboard",
          artboardId: drag.artboardId,
          patch: { x: drag.current.x, y: drag.current.y },
        });
      } else if (
        documentStore.document.activeArtboardId !== drag.artboardId
      ) {
        // Plain click on the label: activate that board.
        documentStore.apply({
          type: "set-active-artboard",
          artboardId: drag.artboardId,
        });
        setSelection([]);
      }
      syncScene();
      return;
    }

    if (drag.kind === "gradient") {
      if (drag.moved) {
        // One history entry per annotator gesture; the fill patch's
        // inverse restores the previous paint exactly.
        documentStore.apply({
          type: "update-nodes",
          updates: [{ nodeId: drag.nodeId, patch: { fill: drag.paint } }],
        });
      } else {
        documentStore.cancelPreview();
      }
      syncScene();
      return;
    }

    if (drag.kind === "draw") {
      // Drag commits the drawn size; a plain click places the default.
      const node = drag.moved
        ? buildDraftShape(drag)
        : makeNodeForTool(drag.tool, drag.start);
      if (node) {
        documentStore.apply({
          type: "insert-nodes",
          artboardId: documentStore.document.activeArtboardId,
          nodes: [node],
        });
        setSelection([node.id]);
      }
      setTool("select");
      syncScene();
      return;
    }

    if (drag.kind === "marquee") {
      if (drag.current && (drag.current.width > 2 || drag.current.height > 2)) {
        const document = documentStore.document;
        const state = useEditorStore.getState();
        // Inside a group scope the marquee picks that group's children;
        // at top level it picks units (groups as a whole).
        const candidateIds = state.activeGroupId
          ? getContainerChildIds(document, state.activeGroupId)
          : getActiveArtboard(document).nodeIds;
        const box = drag.current;
        const hits: string[] = [];
        for (const nodeId of candidateIds) {
          const node = document.nodes[nodeId];
          if (!node || !node.visible || node.locked) {
            continue;
          }
          // Rotated leaves intersect by their rotated AABB.
          const bounds =
            node.type === "group"
              ? unitBounds(document, nodeId)
              : nodeBounds(node);
          if (!bounds) {
            continue;
          }
          const intersects =
            bounds.x < box.x + box.width &&
            bounds.x + bounds.width > box.x &&
            bounds.y < box.y + box.height &&
            bounds.y + bounds.height > box.y;
          if (intersects) {
            hits.push(nodeId);
          }
        }
        setSelection(hits);
      }
      syncScene();
      return;
    }

    if (drag.kind === "rotate") {
      setHandleHint(null);
      if (drag.moved && drag.patches.length > 0) {
        // One history entry for the whole gesture.
        documentStore.apply({ type: "update-nodes", updates: drag.patches });
        recordTransform({
          kind: "rotate",
          degrees: drag.delta,
          pivot: drag.pivot,
          copy: false,
        });
      } else {
        documentStore.cancelPreview();
      }
      syncScene();
      return;
    }

    if (
      (drag.kind === "move" || drag.kind === "resize") &&
      drag.moved &&
      drag.patches.length > 0
    ) {
      // Pixel snap is a commit-time concern: previews stay fluid, the
      // history entry gets whole-pixel geometry.
      const updates = useEditorStore.getState().pixelSnap
        ? drag.patches.map(({ nodeId, patch }) => ({
            nodeId,
            patch: pixelSnapPatch(patch),
          }))
        : drag.patches;
      documentStore.apply({ type: "update-nodes", updates });

      if (drag.kind === "move") {
        recordTransform({
          kind: "move",
          dx: drag.appliedDx,
          dy: drag.appliedDy,
          copy: drag.copied,
        });
      } else if (drag.frameRotation === 0) {
        // Scale about the anchor the handle held still. Tilted-frame
        // resizes are not recorded (their anchor is not axis-aligned).
        const start = drag.startBounds;
        const last = drag.lastBounds;
        recordTransform({
          kind: "scale",
          sx: last.width / start.width,
          sy: last.height / start.height,
          pivot: {
            x: drag.handle.includes("w") ? start.x + start.width : start.x,
            y: drag.handle.includes("n") ? start.y + start.height : start.y,
          },
          copy: false,
        });
      }
    } else if (drag.kind === "move" || drag.kind === "resize") {
      documentStore.cancelPreview();

      // Plain re-click (no drag) on a member of a multi-selection marks
      // it as the align key object; re-clicking the key unmarks it.
      if (drag.kind === "move" && drag.reclickedUnitId) {
        const state = useEditorStore.getState();
        if (state.selectedNodeIds.length > 1) {
          state.setKeyObjectId(
            state.keyObjectId === drag.reclickedUnitId
              ? null
              : drag.reclickedUnitId,
          );
        }
      }
    }

    // Drop any lingering smart guides.
    syncScene();
  }

  function handleDoubleClick(event: React.MouseEvent<HTMLCanvasElement>) {
    const state = useEditorStore.getState();
    if (editRef.current || editingTextRef.current || state.tool !== "select") {
      return;
    }

    const renderer = rendererRef.current;
    const rect = canvasRef.current!.getBoundingClientRect();
    const hit = renderer?.hitTest({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });

    if (!hit) {
      // Double-click on empty canvas steps out of the group scope.
      if (state.activeGroupId) {
        const document = documentStore.document;
        const chain = getAncestorGroupIds(document, state.activeGroupId);
        state.setSelection([state.activeGroupId]);
        state.setActiveGroupId(chain[chain.length - 1] ?? null);
        syncScene();
      }
      return;
    }

    // Double-clicking a group unit enters it one level, selecting the
    // child under the cursor; on a leaf it starts path/text editing.
    const { unitId } = resolveUnit(
      documentStore.document,
      hit.id,
      state.activeGroupId,
      false,
    );
    const unit = documentStore.document.nodes[unitId];
    if (unit?.type === "group") {
      const path = [
        ...getAncestorGroupIds(documentStore.document, hit.id),
        hit.id,
      ];
      const deeper = path[path.indexOf(unitId) + 1] ?? hit.id;
      state.setActiveGroupId(unitId);
      setSelection([deeper]);
      syncScene();
      return;
    }

    if (hit.type === "path" && hit.geometry && hit.rotation === 0) {
      startPathEdit(hit);
      return;
    }

    if (hit.type === "text") {
      editingTextRef.current = hit.id;
      setEditingTextId(hit.id);
      setSelection([hit.id]);
      syncScene();
    }
  }

  /**
   * ⌥←/⌥→ in the text-edit overlay: adjust one pair's kerning. Any
   * pending content edit commits in the same command so the pair index
   * refers to what the user actually sees; stale entries are pruned.
   */
  function kernTextPair(
    nodeId: string,
    pairIndex: number,
    delta: number,
    draft: string,
  ) {
    const node = documentStore.document.nodes[nodeId];
    if (!node || node.type !== "text") {
      return;
    }
    const kerning = withKernAdjusted(
      pruneKerning(node.kerning, draft),
      pairIndex,
      delta,
    );
    documentStore.apply({
      type: "update-nodes",
      updates: [
        {
          nodeId,
          patch: {
            kerning,
            ...(node.content !== draft ? { content: draft } : {}),
          },
        },
      ],
    });
  }

  function finishTextEdit(nodeId: string, content: string, commit: boolean) {
    editingTextRef.current = null;
    setEditingTextId(null);

    const node = documentStore.document.nodes[nodeId];
    if (commit && node && node.type === "text" && node.content !== content) {
      documentStore.apply({
        type: "update-nodes",
        updates: [{ nodeId, patch: { content } }],
      });
    }
    syncScene();
  }

  return (
    <div
      ref={containerRef}
      className="canvas-host absolute inset-0 overflow-hidden overscroll-none"
    >
      <canvas
        ref={canvasRef}
        className={`gpu-canvas block h-full w-full touch-none bg-transparent ${
          spaceHeld
            ? "cursor-grab"
            : tool === "pen" || tool === "gradient" || SHAPE_DRAW_TOOLS.has(tool)
              ? "cursor-crosshair"
              : "cursor-default"
        }`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        aria-label="OpenLogo canvas"
      />
      <GradientAnnotator />
      {editingTextId && (
        <TextEditOverlay
          nodeId={editingTextId}
          onDone={finishTextEdit}
          onKern={kernTextPair}
        />
      )}
      {handleHint && (
        <div className="canvas-hint pointer-events-none absolute bottom-20 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-full border border-[rgb(255_255_255/0.07)] bg-[rgb(23_21_27/0.88)] px-13 py-6 text-[11.5px] tracking-[0.01em] text-[#e8e6ee] shadow-[0_4px_16px_rgb(20_17_26/0.25)]">
          {handleHint}
        </div>
      )}
      <CanvasRulers
        onGuideStart={startGuideFromRuler}
        onGuideMove={moveGuideFromRuler}
        onGuideEnd={commitGuideDrag}
      />
    </div>
  );
}
