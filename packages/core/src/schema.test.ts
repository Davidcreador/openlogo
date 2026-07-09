import { describe, expect, it } from "vitest";
import { createArtboard, createInitialDocument } from "./factory";
import { ARTBOARD_GAP } from "./queries";
import { parseDocument } from "./schema";
import { DOCUMENT_SCHEMA_VERSION } from "./types";

describe("parseDocument", () => {
  it("round-trips a freshly created document through JSON", () => {
    const doc = createInitialDocument();
    const parsed = parseDocument(JSON.parse(JSON.stringify(doc)));
    expect(parsed).toEqual(doc);
  });

  it("rejects malformed documents", () => {
    expect(() => parseDocument({ nope: true })).toThrow();
  });

  it("rejects documents from a newer schema version", () => {
    const doc = createInitialDocument();
    doc.schemaVersion = DOCUMENT_SCHEMA_VERSION + 1;
    expect(() => parseDocument(JSON.parse(JSON.stringify(doc)))).toThrow(
      /newer/,
    );
  });
});

describe("artboard position migration", () => {
  /** Serialized doc with the given artboards, x/y stripped where undefined. */
  function payloadWith(
    boards: Array<{ width: number; height: number; x?: number; y?: number }>,
  ) {
    const doc = createInitialDocument();
    const artboards = boards.map((box, index) => {
      const artboard: Record<string, unknown> = {
        ...createArtboard("primary", {
          name: `Board ${index}`,
          width: box.width,
          height: box.height,
          nodeIds: index === 0 ? doc.artboards[0]!.nodeIds : [],
        }),
      };
      if (box.x === undefined) {
        delete artboard.x;
        delete artboard.y;
      } else {
        artboard.x = box.x;
        artboard.y = box.y;
      }
      return artboard;
    });
    return JSON.parse(
      JSON.stringify({
        ...doc,
        artboards,
        activeArtboardId: artboards[0]!.id,
      }),
    );
  }

  it("lays out position-less artboards left-to-right with a gap", () => {
    const parsed = parseDocument(
      payloadWith([
        { width: 720, height: 420 },
        { width: 300, height: 250 },
        { width: 1080, height: 1080 },
      ]),
    );
    const [a, b, c] = parsed.artboards;
    expect(a).toMatchObject({ x: 0, y: 0 });
    expect(b).toMatchObject({ x: 720 + ARTBOARD_GAP, y: 0 });
    expect(c).toMatchObject({
      x: 720 + ARTBOARD_GAP + 300 + ARTBOARD_GAP,
      y: 0,
    });
  });

  it("places migrated artboards after the positioned ones", () => {
    const parsed = parseDocument(
      payloadWith([
        { width: 720, height: 420, x: 100, y: 50 },
        { width: 300, height: 250 },
      ]),
    );
    expect(parsed.artboards[0]).toMatchObject({ x: 100, y: 50 });
    expect(parsed.artboards[1]).toMatchObject({
      x: 100 + 720 + ARTBOARD_GAP,
      y: 50,
    });
  });

  it("leaves fully positioned documents untouched", () => {
    const doc = createInitialDocument();
    doc.artboards[0]!.x = -40;
    doc.artboards[0]!.y = 900;
    const parsed = parseDocument(JSON.parse(JSON.stringify(doc)));
    expect(parsed.artboards[0]).toMatchObject({ x: -40, y: 900 });
  });
});
