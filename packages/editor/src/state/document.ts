import { useSyncExternalStore } from "react";
import {
  DocumentStore,
  type LogoDocument,
  createInitialDocument,
} from "@openlogo/core";

/**
 * Single DocumentStore for the app. Lives outside React so the renderer
 * and pointer handlers can read/mutate it without going through state.
 */
export const documentStore = new DocumentStore(createInitialDocument());

export function useDocument(): LogoDocument {
  return useSyncExternalStore(
    (onChange) => documentStore.subscribe(onChange),
    () => documentStore.document,
  );
}
