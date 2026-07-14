import { Effect } from "effect";
import { getActiveArtboard, parseDocumentEffect } from "@openlogo/core";
import { documentToSvg, downloadTextFile, nodesToSvg } from "./export";
import { documentLibrary } from "./document-library";
import { ensureDocumentFonts } from "./text-to-path";
import { documentStore } from "../state/document";
import { useEditorStore } from "../state/editor-store";

/**
 * .openlogo documents: plain JSON of the LogoDocument, gated on load by
 * the same zod parse + referential sanitize every untrusted payload goes
 * through (parseDocument). Opening imports an independent local document;
 * a colliding document id becomes a copy instead of overwriting a head.
 */

export const OPENLOGO_EXTENSION = ".openlogo";

export function saveDocumentFile(): void {
  const document = documentStore.committedDocument;
  const base =
    document.name.trim().toLowerCase().replaceAll(" ", "-") || "logo";
  downloadTextFile(
    JSON.stringify(document, null, 2),
    `${base}${OPENLOGO_EXTENSION}`,
    "application/json",
  );
}

/** Open failure the UI turns into a toast (never a crash). */
export type OpenDocumentError = {
  readonly _tag: "OpenDocumentError";
  readonly message: string;
};

const openError = (message: string): OpenDocumentError => ({
  _tag: "OpenDocumentError",
  message,
});

/**
 * Parse and adopt a .openlogo file: validated (zod), migrated and
 * sanitized by parseDocument; the editor state resets around it.
 */
const openDocumentFile = (
  file: File,
): Effect.Effect<void, OpenDocumentError> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => file.text(),
      catch: () => openError(`Could not read “${file.name}”.`),
    });

    const data = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => openError(`“${file.name}” is not valid JSON.`),
    });

    const document = yield* parseDocumentEffect(data).pipe(
      Effect.mapError(() =>
        openError(`“${file.name}” is not a valid OpenLogo document.`),
      ),
    );

    const imported = yield* Effect.tryPromise({
      try: () => documentLibrary.importDocument(document),
      catch: (error) =>
        openError(
          error instanceof Error
            ? error.message
            : `Could not import “${file.name}” into the Document library.`,
        ),
    });

    yield* Effect.sync(() => {
      const state = useEditorStore.getState();
      if (state.view === "dashboard") {
        documentStore.reset(imported);
        state.setRendererReady(false);
        state.setDocumentSessionState("loading");
        state.setDocumentLibraryOpen(false);
        state.setView("editor");
      }
      state.setSelection([]);
      state.setActiveGroupId(null);
      state.setEditingPathId(null);
      state.setTool("select");
      ensureDocumentFonts();
    });
  });

/** Run the open flow; failures surface as a toast. */
export function openDocumentFileWithToast(file: File): void {
  void Effect.runPromise(
    openDocumentFile(file).pipe(
      Effect.tap(() =>
        Effect.sync(() =>
          useEditorStore.getState().setToast(`Opened “${file.name}”.`),
        ),
      ),
      Effect.catchAll((error) =>
        Effect.sync(() => useEditorStore.getState().setToast(error.message)),
      ),
    ),
  );
}

/** Transient file input so Open works from both TopBar and ⌘O. */
export function promptOpenDocument(): void {
  const input = window.document.createElement("input");
  input.type = "file";
  input.accept = `${OPENLOGO_EXTENSION},application/json`;
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) {
      openDocumentFileWithToast(file);
    }
  };
  input.click();
}

/**
 * OS clipboard "Copy as SVG" (⇧⌘C): the selection when there is one,
 * otherwise the active board. Written as a ClipboardItem carrying BOTH
 * image/svg+xml and text/plain; engines that reject the SVG flavour
 * (or ClipboardItem entirely) fall back to plain-text SVG markup, which
 * design tools paste fine.
 */
export async function copyAsSvg(): Promise<boolean> {
  const document = documentStore.committedDocument;
  const selection = useEditorStore.getState().selectedNodeIds;
  const svg =
    selection.length > 0
      ? (nodesToSvg(document, selection) ?? documentToSvg(document))
      : documentToSvg(document, getActiveArtboard(document));

  try {
    const item = new ClipboardItem({
      "image/svg+xml": new Blob([svg], { type: "image/svg+xml" }),
      "text/plain": new Blob([svg], { type: "text/plain" }),
    });
    await navigator.clipboard.write([item]);
  } catch {
    try {
      await navigator.clipboard.writeText(svg);
    } catch {
      useEditorStore.getState().setToast("Clipboard unavailable.");
      return false;
    }
  }
  useEditorStore.getState().setToast("SVG copied to the clipboard.");
  return true;
}
