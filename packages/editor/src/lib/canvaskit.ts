import { Data, Effect } from "effect";
import type { CanvasKit } from "canvaskit-wasm";
import wasmUrl from "canvaskit-wasm/bin/canvaskit.wasm?url";
import { loadCanvasKit } from "@openlogo/renderer";

export class CanvasKitLoadError extends Data.TaggedError("CanvasKitLoadError")<{
  readonly cause: unknown;
}> {}

/**
 * App-wide CanvasKit instance. `Effect.cached` memoizes the load so every
 * consumer shares one WASM fetch (the renderer's own promise memo is the
 * second line of defense).
 */
export const canvasKit: Effect.Effect<CanvasKit, CanvasKitLoadError> =
  Effect.runSync(
    Effect.cached(
      Effect.tryPromise({
        try: () => loadCanvasKit(wasmUrl),
        catch: (cause) => new CanvasKitLoadError({ cause }),
      }),
    ),
  );

/**
 * Promise view for imperative call sites (render-loop init, pointer-driven
 * geometry ops) that deliberately stay outside Effect.
 */
export function getCanvasKit(): Promise<CanvasKit> {
  return Effect.runPromise(canvasKit);
}
