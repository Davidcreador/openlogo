import { describe, expect, it } from "vitest";
import { DESIGN_BRIEF_LIMITS } from "./brief";
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

  it("migrates a v4 document without a brief additively to v5", () => {
    const doc = createInitialDocument();
    const payload = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    payload.schemaVersion = 4;
    delete payload.designBrief;

    const parsed = parseDocument(payload);

    expect(parsed.schemaVersion).toBe(5);
    expect(parsed).not.toHaveProperty("designBrief");
    expect(parsed.id).toBe(doc.id);
    expect(parsed.artboards).toEqual(doc.artboards);
    expect(parsed.nodes).toEqual(doc.nodes);
    expect(parsed.palettes).toEqual(doc.palettes);
  });

  it("sanitizes, bounds, strips, and round-trips a design brief", () => {
    const doc = createInitialDocument();
    const payload = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    payload.unrecognizedDocumentField = true;
    payload.designBrief = {
      brandName: `  ${"B".repeat(DESIGN_BRIEF_LIMITS.brandNameLength + 20)}  `,
      offering: "  Collaborative identity tools  ",
      audience: "   ",
      attributes: ["  precise ", "", "precise", " approachable  "],
      avoid: ["generic", " generic ", "   "],
      competitors: [],
      primaryUseCases: Array.from(
        { length: DESIGN_BRIEF_LIMITS.listItems + 5 },
        (_, index) => ` Use ${index} `,
      ),
      mustKeep: ["M".repeat(DESIGN_BRIEF_LIMITS.listItemLength + 10)],
      constraints: "\n Works in one color. \n",
      notes: "  Retain the open counter.  ",
      unrecognizedBriefField: "strip me",
    };

    const parsed = parseDocument(payload);

    expect(parsed.designBrief).toEqual({
      brandName: "B".repeat(DESIGN_BRIEF_LIMITS.brandNameLength),
      offering: "Collaborative identity tools",
      attributes: ["precise", "approachable"],
      avoid: ["generic"],
      primaryUseCases: Array.from(
        { length: DESIGN_BRIEF_LIMITS.listItems },
        (_, index) => `Use ${index}`,
      ),
      mustKeep: ["M".repeat(DESIGN_BRIEF_LIMITS.listItemLength)],
      constraints: "Works in one color.",
      notes: "Retain the open counter.",
    });
    expect(parsed).not.toHaveProperty("unrecognizedDocumentField");
    expect(parsed.designBrief).not.toHaveProperty("unrecognizedBriefField");
    expect(
      parseDocument(JSON.parse(JSON.stringify(parsed))),
    ).toEqual(parsed);
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

  it("round-trips explicit compound-path fill rules", () => {
    const doc = createInitialDocument();
    const path = Object.values(doc.nodes).find((node) => node.type === "path");
    expect(path).toBeDefined();
    if (!path || path.type !== "path") {
      return;
    }
    path.fillRule = "evenodd";

    const parsed = parseDocument(JSON.parse(JSON.stringify(doc)));
    expect(parsed.nodes[path.id]).toMatchObject({ fillRule: "evenodd" });
  });

  it("migrates pre-v3 paths to explicit nonzero fill", () => {
    const doc = createInitialDocument();
    doc.schemaVersion = 2;
    const path = Object.values(doc.nodes).find((node) => node.type === "path");
    expect(path).toBeDefined();
    if (!path) {
      return;
    }
    delete (path as unknown as { fillRule?: unknown }).fillRule;

    const parsed = parseDocument(JSON.parse(JSON.stringify(doc)));
    expect(parsed.schemaVersion).toBe(DOCUMENT_SCHEMA_VERSION);
    expect(parsed.nodes[path.id]).toMatchObject({ fillRule: "nonzero" });
  });

  it("rejects unknown path fill rules", () => {
    const doc = createInitialDocument();
    const path = Object.values(doc.nodes).find((node) => node.type === "path");
    expect(path).toBeDefined();
    if (!path) {
      return;
    }
    (path as unknown as Record<string, unknown>).fillRule = "inverse";

    expect(() => parseDocument(JSON.parse(JSON.stringify(doc)))).toThrow();
  });

  it("repairs legacy gradient offsets and unsafe OpenType feature tags", () => {
    const doc = createInitialDocument();
    const drawable = Object.values(doc.nodes).find(
      (node) => node.type !== "group",
    )!;
    drawable.fill = {
      type: "linear-gradient",
      angle: 0,
      stops: [
        { offset: 2, color: "#fff" },
        { offset: -1, color: "#000" },
      ],
    };
    const text = Object.values(doc.nodes).find((node) => node.type === "text");
    if (text?.type === "text") {
      text.otFeatures = {
        liga: false,
        [`x';filter:url(evil)`]: true,
      };
    }

    const parsed = parseDocument(JSON.parse(JSON.stringify(doc)));
    const fill = parsed.nodes[drawable.id]!.fill;
    expect(fill.type).toBe("linear-gradient");
    if (fill.type === "linear-gradient") {
      expect(fill.stops.map((stop) => stop.offset)).toEqual([0, 1]);
    }
    if (text?.type === "text") {
      expect(parsed.nodes[text.id]).toMatchObject({
        otFeatures: { liga: false },
      });
    }
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
