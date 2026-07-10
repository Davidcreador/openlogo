import { createInitialDocument, createPath, createText } from "@openlogo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachTextToPath } from "./text-on-path";
import { fontStore } from "./font-store";
import { documentStore } from "../state/document";

describe("text on path", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preloads the exact italic face before attaching text", () => {
    const ensure = vi.spyOn(fontStore, "ensure").mockResolvedValue(null);
    const document = createInitialDocument();
    const path = createPath({ x: 10, y: 20 });
    const text = createText({ x: 0, y: 0, content: "Italic" });
    text.fontStyle = "italic";
    document.nodes = { [path.id]: path, [text.id]: text };
    document.artboards[0] = {
      ...document.artboards[0]!,
      nodeIds: [path.id, text.id],
    };
    documentStore.reset(document);

    attachTextToPath(text.id, path.id);

    expect(ensure).toHaveBeenCalledWith(
      text.fontFamily,
      text.fontWeight,
      "italic",
    );
    const attached = documentStore.committedDocument.nodes[text.id];
    expect(attached?.type).toBe("text");
    if (attached?.type === "text") {
      expect(attached.onPath?.pathId).toBe(path.id);
    }
  });
});
