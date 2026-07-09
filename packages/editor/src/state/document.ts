import { useSyncExternalStore } from "react";
import {
  DocumentStore,
  type LogoDocument,
  createInitialDocument,
} from "@openlogo/core";

/**
 * Single DocumentStore for the app. Lives outside React so the renderer
 * and pointer handlers can read/mutate it without going through state.
 *
 * Effect boundary decision: this store (and editor-store) stays a plain
 * module singleton rather than an Effect Layer/Context service. Its
 * consumers are useSyncExternalStore, the 60fps render loop, and pointer
 * handlers — all of which need synchronous, zero-allocation reads;
 * threading a Context through them would force a runtime/provider layer
 * into React and Effect into per-frame paths for no typed-error gain.
 * Effect stops at the async edges (persistence, fonts, export, import)
 * and inside DocumentStore.apply's defect isolation in @openlogo/core.
 */
export const documentStore = new DocumentStore(createInitialDocument());

export function useDocument(): LogoDocument {
  return useSyncExternalStore(
    (onChange) => documentStore.subscribe(onChange),
    () => documentStore.document,
  );
}
