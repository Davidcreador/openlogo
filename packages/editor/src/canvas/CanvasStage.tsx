import { useCallback, useEffect, useRef } from "react";
import wasmUrl from "canvaskit-wasm/bin/canvaskit.wasm?url";
import {
  type Bounds,
  type LogoNode,
  type NodePatch,
  type Vec2,
  createEllipse,
  createPath,
  createRectangle,
  createText,
  getActiveArtboard,
} from "@openlogo/core";
import {
  FontRegistry,
  type HandleId,
  SceneRenderer,
  fitBounds,
  loadCanvasKit,
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

type DragState =
  | { kind: "pan"; last: Vec2 }
  | {
      kind: "move";
      startLocal: Vec2;
      snapshots: Map<string, NodeSnapshot>;
      patches: Array<{ nodeId: string; patch: NodePatch }>;
      moved: boolean;
    }
  | {
      kind: "resize";
      handle: HandleId;
      startLocal: Vec2;
      startBounds: Bounds;
      snapshots: Map<string, NodeSnapshot>;
      patches: Array<{ nodeId: string; patch: NodePatch }>;
      moved: boolean;
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
  const cameraFittedRef = useRef(false);

  const document = useDocument();
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const camera = useEditorStore((state) => state.camera);
  const setTool = useEditorStore((state) => state.setTool);
  const setSelection = useEditorStore((state) => state.setSelection);
  const setCamera = useEditorStore((state) => state.setCamera);
  const setRendererReady = useEditorStore((state) => state.setRendererReady);

  const syncScene = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) {
      return;
    }
    const state = useEditorStore.getState();
    const drag = dragRef.current;
    renderer.setScene({
      document: documentStore.document,
      camera: state.camera,
      selectedNodeIds: state.selectedNodeIds,
      marquee: drag?.kind === "marquee" ? drag.current : null,
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
      const canvasKit = await loadCanvasKit(wasmUrl);
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
    };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }

    const screen = getScreenPoint(event);

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
      drag.patches = [...drag.snapshots.entries()].map(([nodeId, snap]) => ({
        nodeId,
        patch: { x: snap.x + dx, y: snap.y + dy },
      }));
      drag.moved = drag.moved || dx !== 0 || dy !== 0;
      documentStore.preview(drag.patches);
      return;
    }

    // Resize.
    const next = resizeBounds(drag.startBounds, drag.handle, dx, dy);
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
        className="gpu-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onWheel={handleWheel}
        aria-label="OpenLogo canvas"
      />
      <div className="zoom-pill">{Math.round(camera.zoom * 100)}%</div>
    </div>
  );
}
