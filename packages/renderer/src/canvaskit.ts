import type { CanvasKit } from "canvaskit-wasm";
import CanvasKitInit from "canvaskit-wasm";

let instance: Promise<CanvasKit> | null = null;

/**
 * Load the CanvasKit WASM module once per page. The editor passes the wasm
 * asset URL (Vite: `import wasmUrl from "canvaskit-wasm/bin/canvaskit.wasm?url"`).
 */
export function loadCanvasKit(wasmUrl: string): Promise<CanvasKit> {
  instance ??= CanvasKitInit({
    locateFile: () => wasmUrl,
  });
  return instance;
}
