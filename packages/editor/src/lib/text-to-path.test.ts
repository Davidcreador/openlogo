import { createInitialDocument, createText } from "@openlogo/core";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TextOutlineUnavailableError,
  buildOutlineLetterNodes,
  convertTextToPath,
  outlineDocumentTexts,
} from "./text-to-path";
import type opentype from "opentype.js";
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

/**
 * Minimal opentype.js font stub: every glyph is a 500-unit square at
 * the pen position (empty for spaces), 600-unit advance, no kerning.
 */
function stubFont(): opentype.Font {
  return {
    unitsPerEm: 1000,
    ascender: 800,
    getKerningValue: () => 0,
    charToGlyph: (char: string) => ({
      index: char.codePointAt(0),
      advanceWidth: 600,
      getPath: (x: number, y: number, size: number) => ({
        commands:
          char === " "
            ? []
            : [
                { type: "M", x, y },
                { type: "L", x: x + size / 2, y },
                { type: "L", x: x + size / 2, y: y - size / 2 },
                { type: "Z" },
              ],
      }),
    }),
  } as unknown as opentype.Font;
}

describe("per-letter outlines", () => {
  it("produces one path node per letter, named after its character", () => {
    const text = createText({ x: 0, y: 0, content: "No" });
    text.fontSize = 100;
    text.letterSpacing = 0;
    const letters = buildOutlineLetterNodes(stubFont(), text);

    expect(letters).toHaveLength(2);
    expect(letters.map((letter) => letter.name)).toEqual(["N", "o"]);
    expect(letters.every((letter) => letter.type === "path")).toBe(true);
    // Second letter starts one 600-unit advance (60px at 100/1000) right.
    expect(letters[1]!.x - letters[0]!.x).toBeCloseTo(60, 5);
  });

  it("skips empty glyphs like spaces", () => {
    const text = createText({ x: 0, y: 0, content: "a b" });
    text.fontSize = 100;
    const letters = buildOutlineLetterNodes(stubFont(), text);

    expect(letters.map((letter) => letter.name)).toEqual(["a", "b"]);
  });

  it("orbits letters around the text centre when rotated", () => {
    const text = createText({ x: 0, y: 0, content: "ab" });
    text.fontSize = 100;
    text.width = 120;
    text.height = 100;
    const flat = buildOutlineLetterNodes(stubFont(), text);
    text.rotation = 180;
    const rotated = buildOutlineLetterNodes(stubFont(), text);

    // At 180° the letters swap sides around the text centre.
    const centre = (letter: { x: number; width: number }) =>
      letter.x + letter.width / 2;
    expect(centre(rotated[0]!)).toBeCloseTo(
      2 * (text.x + text.width / 2) - centre(flat[0]!),
      5,
    );
    expect(rotated[0]!.rotation).toBe(180);
  });

  it("keeps fill and stroke on every letter", () => {
    const text = createText({ x: 0, y: 0, content: "ab" });
    text.fill = { type: "solid", color: "#ff0055" };
    text.stroke = { color: "#111111", width: 2, align: "center" };
    const letters = buildOutlineLetterNodes(stubFont(), text);

    for (const letter of letters) {
      expect(letter.fill).toEqual({ type: "solid", color: "#ff0055" });
      expect(letter.stroke).toEqual({
        color: "#111111",
        width: 2,
        align: "center",
      });
    }
  });
});
