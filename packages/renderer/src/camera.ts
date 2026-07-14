import type { Bounds, Vec2 } from "@openlogo/core";

/**
 * Viewport camera: world (artboard) space ↔ screen (canvas CSS px) space.
 * Screen = (world - offset) * zoom.
 */
export type Camera = {
  /** World coordinate at the top-left of the viewport. */
  offset: Vec2;
  zoom: number;
};

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 32;

export function createCamera(): Camera {
  return { offset: { x: 0, y: 0 }, zoom: 1 };
}

export function worldToScreen(camera: Camera, point: Vec2): Vec2 {
  return {
    x: (point.x - camera.offset.x) * camera.zoom,
    y: (point.y - camera.offset.y) * camera.zoom,
  };
}

export function screenToWorld(camera: Camera, point: Vec2): Vec2 {
  return {
    x: point.x / camera.zoom + camera.offset.x,
    y: point.y / camera.zoom + camera.offset.y,
  };
}

/** Zoom keeping the given screen point stationary (wheel/pinch anchor). */
export function zoomAt(
  camera: Camera,
  screenPoint: Vec2,
  nextZoomRaw: number,
): Camera {
  const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoomRaw));
  const anchor = screenToWorld(camera, screenPoint);

  return {
    zoom: nextZoom,
    offset: {
      x: anchor.x - screenPoint.x / nextZoom,
      y: anchor.y - screenPoint.y / nextZoom,
    },
  };
}

export function panBy(camera: Camera, screenDelta: Vec2): Camera {
  return {
    ...camera,
    offset: {
      x: camera.offset.x - screenDelta.x / camera.zoom,
      y: camera.offset.y - screenDelta.y / camera.zoom,
    },
  };
}

/** Fit bounds into a viewport with padding, centred. */
export function fitBounds(
  bounds: Bounds,
  viewportWidth: number,
  viewportHeight: number,
  padding = 48,
  maxZoom = MAX_ZOOM,
): Camera {
  const zoomX = (viewportWidth - padding * 2) / bounds.width;
  const zoomY = (viewportHeight - padding * 2) / bounds.height;
  const zoom = Math.min(maxZoom, Math.max(MIN_ZOOM, Math.min(zoomX, zoomY)));

  return {
    zoom,
    offset: {
      x: bounds.x + bounds.width / 2 - viewportWidth / zoom / 2,
      y: bounds.y + bounds.height / 2 - viewportHeight / zoom / 2,
    },
  };
}
