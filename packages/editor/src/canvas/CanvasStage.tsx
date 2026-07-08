import { useCallback, useEffect, useRef } from "react";
import { getCanvasKit } from "../lib/canvaskit";
import {
  type Bounds,
  type LogoNode,
  type NodePatch,
  type PathGeometry,
  type PathNode,
  type PathPoint,
  type SnapGuide,
  type Vec2,
  computeSnap,
  createEllipse,
  createId,
  createPath,
  createRectangle,
  createText,
  findSegmentNear,
  getActiveArtboard,
  insertAnchor,
  pathGeometryBounds,
  pathGeometryToSvg,
  removeAnchor,
  snapValue,
  translatePathGeometry,
} from "@openlogo/core";
import {
  FontRegistry,
  type HandleId,
  SceneRenderer,
  fitBounds,
  panBy,
  screenToWorld,
  selectionHandles,
  worldToScreen,
  zoomAt,
} from "@openlogo/renderer";
import { documentStore, useDocument } from "../state/document";
import { type Tool, useEditorStore } from "../state/editor-store";

const HANDLE_HIT_RADIUS = 7;
const FONT_URL = "/fonts/Inter-Variable.ttf";

type NodeSnapshot = {
  x: number;
  y: number;
  width: number;
  height: number;
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
    part: "anchor" | "in" | "out";
  } | null;
  selected: { subpath: number; index: number } | null;
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
      /** Static snap candidates: unselected nodes + the artboard box. */
      snapTargets: Bounds[];
      guides: SnapGuide[];
    }
  | {
      kind: "resize";
      handle: HandleId;
      startLocal: Vec2;
      startBounds: Bounds;
      snapshots: Map<string, NodeSnapshot>;
      patches: Array<{ nodeId: string; patch: NodePatch }>;
      moved: boolean;
      snapTargets: Bounds[];
      guides: SnapGuide[];
    }
  | { kind: "marquee"; startLocal: Vec2; current: Bounds | null };

function snapshotNodes(nodeIds: readonly string[]): Map<string, NodeSnapshot> {
  const map = new Map<string, NodeSnapshot>();
  for (const nodeId of nodeIds) {
    const node = documentStore.document.nodes[nodeId];
    if (node && !node.locked) {
      map.set(nodeId, {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
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

  for (const nodeId of artboard.nodeIds) {
    const node = document.nodes[nodeId];
    if (node && node.visible && !excludedIds.has(nodeId)) {
      targets.push({
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
      });
    }
  }

  return targets;
}

/** Node patch for a path whose artboard-local geometry changed. */
function patchFromLocalGeometry(geometry: PathGeometry): NodePatch | null {
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
  };
}

/** Denormalise a path node's geometry into artboard-local coordinates. */
function localGeometryOf(node: PathNode): PathGeometry | null {
  if (!node.geometry) {
    return null;
  }
  const sx = node.width / node.intrinsicWidth;
  const sy = node.height / node.intrinsicHeight;
  const map = (p: Vec2): Vec2 => ({
    x: node.x + p.x * sx,
    y: node.y + p.y * sy,
  });

  return {
    subpaths: node.geometry.subpaths.map((subpath) => ({
      closed: subpath.closed,
      points: subpath.points.map((point) => ({
        ...map(point),
        ...(point.handleIn ? { handleIn: map(point.handleIn) } : {}),
        ...(point.handleOut ? { handleOut: map(point.handleOut) } : {}),
      })),
    })),
  };
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

export function CanvasStage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const penRef = useRef<PenSession | null>(null);
  const editRef = useRef<PathEditSession | null>(null);
  const cameraFittedRef = useRef(false);

  const document = useDocument();
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
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
    renderer.setScene({
      document: documentStore.document,
      camera: state.camera,
      selectedNodeIds: edit ? [] : state.selectedNodeIds,
      marquee: drag?.kind === "marquee" ? drag.current : null,
      guides:
        drag?.kind === "move" || drag?.kind === "resize" ? drag.guides : null,
      penPreview: pen ? { points: pen.points, cursor: pen.cursor } : null,
      pathEdit: edit
        ? { geometry: edit.geometry, selected: edit.selected }
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

    void (async () => {
      const canvasKit = await getCanvasKit();
      if (cancelled) {
        return;
      }

      const fonts = new FontRegistry(canvasKit);
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

      const applySize = () => {
        const rect = container.getBoundingClientRect();
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
        renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1);

        if (!cameraFittedRef.current && rect.width > 0) {
          cameraFittedRef.current = true;
          const artboard = getActiveArtboard(documentStore.document);
          useEditorStore
            .getState()
            .setCamera(fitBounds(artboard, rect.width, rect.height));
        }
        syncScene();
      };

      const observer = new ResizeObserver(applySize);
      observer.observe(container);
      applySize();
      setRendererReady(true);

      return () => observer.disconnect();
    })();

    return () => {
      cancelled = true;
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [syncScene, setRendererReady]);

  // Push scene whenever document / camera / selection change.
  useEffect(() => {
    syncScene();
  }, [document, camera, selectedNodeIds, syncScene]);

  // Leaving the pen tool cancels an in-progress path.
  useEffect(() => {
    if (tool !== "pen" && penRef.current) {
      penRef.current = null;
      syncScene();
    }
  }, [tool, syncScene]);

  // Enter/Escape finish pen drawing and bezier editing.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (penRef.current) {
        if (event.key === "Enter") {
          event.preventDefault();
          finalizePen(false);
        } else if (event.key === "Escape") {
          cancelPen();
        }
        return;
      }

      if (editRef.current) {
        const edit = editRef.current;

        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          commitPathEdit();
          return;
        }

        if (
          (event.key === "Backspace" || event.key === "Delete") &&
          edit.selected
        ) {
          event.preventDefault();
          const next = removeAnchor(
            edit.geometry,
            edit.selected.subpath,
            edit.selected.index,
          );

          if (!next) {
            // Path would be empty: delete the node and leave edit mode.
            const nodeId = edit.nodeId;
            editRef.current = null;
            setEditingPathId(null);
            documentStore.cancelPreview();
            documentStore.apply({ type: "delete-nodes", nodeIds: [nodeId] });
            setSelection([]);
            syncScene();
            return;
          }

          edit.geometry = next;
          edit.selected = null;
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
      const snapshots = snapshotNodes(state.selectedNodeIds);
      const bounds = snapshotBounds(snapshots);
      if (!bounds) {
        return null;
      }

      const artboard = getActiveArtboard(documentStore.document);
      for (const handle of selectionHandles(bounds)) {
        const handleScreen = worldToScreen(state.camera, {
          x: handle.x + artboard.x,
          y: handle.y + artboard.y,
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
    const geometry = localGeometryOf(node);
    if (!geometry) {
      return;
    }
    editRef.current = {
      nodeId: node.id,
      geometry,
      drag: null,
      selected: null,
      changed: false,
    };
    setEditingPathId(node.id);
    setSelection([]);
    syncScene();
  }

  function commitPathEdit() {
    const edit = editRef.current;
    editRef.current = null;
    setEditingPathId(null);

    if (edit && edit.changed) {
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

    if (edit) {
      setSelection([edit.nodeId]);
    }
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

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const renderer = rendererRef.current;
    if (!canvas || !renderer) {
      return;
    }

    canvas.setPointerCapture(event.pointerId);
    const screen = getScreenPoint(event);

    // Middle mouse or space isn't tracked — middle button pans.
    if (event.button === 1) {
      dragRef.current = { kind: "pan", last: screen };
      return;
    }

    const state = useEditorStore.getState();

    // Bezier edit mode captures all pointer input.
    if (editRef.current) {
      const edit = editRef.current;
      const target = hitEditTarget(screen);

      if (target) {
        edit.drag = target;
        edit.selected =
          target.part === "anchor"
            ? { subpath: target.subpath, index: target.index }
            : edit.selected;
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
          edit.selected = { subpath: segment.subpath, index: inserted.index };
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

    if (state.tool === "pen") {
      const local = toArtboardLocal(screen);
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

    // Resize handle first — takes priority over node hits.
    const handle = hitHandle(screen);
    if (handle) {
      const snapshots = snapshotNodes(state.selectedNodeIds);
      const bounds = snapshotBounds(snapshots);
      if (bounds) {
        dragRef.current = {
          kind: "resize",
          handle,
          startLocal: toArtboardLocal(screen),
          startBounds: bounds,
          snapshots,
          patches: [],
          moved: false,
          snapTargets: collectSnapTargets(new Set(state.selectedNodeIds)),
          guides: [],
        };
      }
      return;
    }

    const hit = renderer.hitTest(screen);

    if (!hit) {
      const local = toArtboardLocal(screen);
      if (!event.shiftKey) {
        setSelection([]);
      }
      dragRef.current = { kind: "marquee", startLocal: local, current: null };
      syncScene();
      return;
    }

    const nextSelection = event.shiftKey
      ? state.selectedNodeIds.includes(hit.id)
        ? state.selectedNodeIds.filter((id) => id !== hit.id)
        : [...state.selectedNodeIds, hit.id]
      : state.selectedNodeIds.includes(hit.id)
        ? state.selectedNodeIds
        : [hit.id];

    setSelection(nextSelection);
    dragRef.current = {
      kind: "move",
      startLocal: toArtboardLocal(screen),
      snapshots: snapshotNodes(nextSelection),
      patches: [],
      moved: false,
      snapTargets: collectSnapTargets(new Set(nextSelection)),
      guides: [],
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const screen = getScreenPoint(event);

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
      } else if (edit.drag.part === "in") {
        point.handleIn = { x: local.x, y: local.y };
      } else {
        point.handleOut = { x: local.x, y: local.y };
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
        // Drag out symmetric handles for the last anchor.
        const anchor = pen.points[pen.points.length - 1]!;
        anchor.handleOut = { x: local.x, y: local.y };
        anchor.handleIn = {
          x: anchor.x * 2 - local.x,
          y: anchor.y * 2 - local.y,
        };
      } else {
        pen.cursor = local;
      }
      syncScene();
      return;
    }

    const drag = dragRef.current;
    if (!drag) {
      return;
    }

    if (drag.kind === "pan") {
      const camera = useEditorStore.getState().camera;
      setCamera(
        panBy(camera, {
          x: screen.x - drag.last.x,
          y: screen.y - drag.last.y,
        }),
      );
      drag.last = screen;
      return;
    }

    const local = toArtboardLocal(screen);

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

    const dx = local.x - drag.startLocal.x;
    const dy = local.y - drag.startLocal.y;

    if (drag.kind === "move") {
      let snapDx = 0;
      let snapDy = 0;
      drag.guides = [];

      // Alt disables snapping, Illustrator-style.
      if (!event.altKey) {
        const startBounds = snapshotBounds(drag.snapshots);
        if (startBounds) {
          const zoom = useEditorStore.getState().camera.zoom;
          const snap = computeSnap(
            { ...startBounds, x: startBounds.x + dx, y: startBounds.y + dy },
            drag.snapTargets,
            6 / zoom,
          );
          snapDx = snap.dx;
          snapDy = snap.dy;
          drag.guides = snap.guides;
        }
      }

      drag.patches = [...drag.snapshots.entries()].map(([nodeId, snap]) => ({
        nodeId,
        patch: { x: snap.x + dx + snapDx, y: snap.y + dy + snapDy },
      }));
      drag.moved = drag.moved || dx !== 0 || dy !== 0;
      documentStore.preview(drag.patches);
      syncScene();
      return;
    }

    // Resize.
    let next = resizeBounds(drag.startBounds, drag.handle, dx, dy);
    drag.guides = [];

    // Snap the dragged edges (Alt disables).
    if (!event.altKey) {
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
    const edit = editRef.current;
    if (edit) {
      edit.drag = null;
      return;
    }

    const pen = penRef.current;
    if (pen) {
      pen.dragging = false;
      return;
    }

    const drag = dragRef.current;
    dragRef.current = null;

    if (!drag) {
      return;
    }

    if (drag.kind === "marquee") {
      if (drag.current && (drag.current.width > 2 || drag.current.height > 2)) {
        const artboard = getActiveArtboard(documentStore.document);
        const box = drag.current;
        const hits: string[] = [];
        for (const nodeId of artboard.nodeIds) {
          const node = documentStore.document.nodes[nodeId];
          if (!node || !node.visible || node.locked) {
            continue;
          }
          const intersects =
            node.x < box.x + box.width &&
            node.x + node.width > box.x &&
            node.y < box.y + box.height &&
            node.y + node.height > box.y;
          if (intersects) {
            hits.push(nodeId);
          }
        }
        setSelection(hits);
      }
      syncScene();
      return;
    }

    if (
      (drag.kind === "move" || drag.kind === "resize") &&
      drag.moved &&
      drag.patches.length > 0
    ) {
      documentStore.apply({ type: "update-nodes", updates: drag.patches });
    } else if (drag.kind === "move" || drag.kind === "resize") {
      documentStore.cancelPreview();
    }

    // Drop any lingering smart guides.
    syncScene();
  }

  function handleDoubleClick(event: React.MouseEvent<HTMLCanvasElement>) {
    if (editRef.current || useEditorStore.getState().tool !== "select") {
      return;
    }

    const renderer = rendererRef.current;
    const rect = canvasRef.current!.getBoundingClientRect();
    const hit = renderer?.hitTest({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });

    if (hit && hit.type === "path" && hit.geometry && hit.rotation === 0) {
      startPathEdit(hit);
    }
  }

  function handleWheel(event: React.WheelEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect();
    const screen = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const camera = useEditorStore.getState().camera;

    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY * 0.0015);
      setCamera(zoomAt(camera, screen, camera.zoom * factor));
    } else {
      setCamera(panBy(camera, { x: -event.deltaX, y: -event.deltaY }));
    }
  }

  return (
    <div ref={containerRef} className="canvas-host">
      <canvas
        ref={canvasRef}
        className={`gpu-canvas ${tool === "pen" ? "is-pen" : ""}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
        aria-label="OpenLogo canvas"
      />
      <div className="zoom-pill">{Math.round(camera.zoom * 100)}%</div>
    </div>
  );
}
