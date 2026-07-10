import { createInitialDocument, createText } from "@openlogo/core";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TextOutlineUnavailableError,
  convertTextToPath,
  outlineDocumentTexts,
} from "./text-to-path";
import { fontStore } from "./font-store";
import { documentStore } from "../state/document";

describe("text outline async session safety", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not replace text after the document is switched during font loading", async () => {
    const source = createInitialDocument();
    const text = createText({ x: 10, y: 20, content: "Race" });
    source.nodes = { [text.id]: text };
    source.artboards[0] = {
      ...source.artboards[0]!,
      nodeIds: [text.id],
    };
    documentStore.reset(source);

    let resolveBytes!: (bytes: ArrayBuffer | null) => void;
    const bytes = new Promise<ArrayBuffer | null>((resolve) => {
      resolveBytes = resolve;
    });
    vi.spyOn(fontStore, "ensureEffect").mockReturnValue(
      Effect.promise(() => bytes),
    );

    const pending = Effect.runPromise(convertTextToPath(text.id));
    const replacement = createInitialDocument();
    documentStore.reset(replacement);
    resolveBytes(new ArrayBuffer(8));

    await expect(pending).resolves.toBeNull();
    expect(documentStore.committedDocument).toBe(replacement);
  });

  it("fails strict document outlining when a required font is unavailable", async () => {
    const document = createInitialDocument();
    vi.spyOn(fontStore, "ensureEffect").mockReturnValue(Effect.succeed(null));
    const error = await Effect.runPromise(
      Effect.flip(outlineDocumentTexts(document, { failOnSkip: true })),
    );
    expect(error).toBeInstanceOf(TextOutlineUnavailableError);
    expect(error._tag).toBe("TextOutlineUnavailableError");
  });
});
