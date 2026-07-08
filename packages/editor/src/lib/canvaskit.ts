import type { CanvasKit } from "canvaskit-wasm";
import wasmUrl from "canvaskit-wasm/bin/canvaskit.wasm?url";
import { loadCanvasKit } from "@openlogo/renderer";

/** App-wide CanvasKit instance (cached after first await). */
export function getCanvasKit(): Promise<CanvasKit> {
  return loadCanvasKit(wasmUrl);
}
