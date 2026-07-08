import { describe, expect, it } from "vitest";
import { createInitialDocument } from "./factory";
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
