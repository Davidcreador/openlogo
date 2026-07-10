import {
  createGroup,
  createInitialDocument,
  createPath,
  createText,
} from "@openlogo/core";
import { afterEach, describe, expect, it } from "vitest";
import { copyNodes, pasteNodes } from "./clipboard";
import { documentStore } from "../state/document";
import { useEditorStore } from "../state/editor-store";

function fixture() {
  const document = createInitialDocument();
  const path = createPath({ x: 20, y: 20 });
  const text = createText({ x: 20, y: 20, content: "On path" });
  text.onPath = { pathId: path.id, startOffset: 12, flip: false };
  const group = createGroup([path.id, text.id]);
  document.nodes = {
    [path.id]: path,
    [text.id]: text,
    [group.id]: group,
  };
  document.artboards[0] = {
    ...document.artboards[0]!,
    nodeIds: [group.id],
  };
  documentStore.reset(document);
  useEditorStore.getState().setActiveGroupId(group.id);
  return { path, text, group };
}

describe("structured clipboard", () => {
  afterEach(() => {
    useEditorStore.getState().setActiveGroupId(null);
  });

  it("pastes into the active group and remaps text-on-path references", () => {
    const { path, text, group } = fixture();
    expect(copyNodes([path.id, text.id])).toBe(2);
    const pastedIds = pasteNodes();
    const document = documentStore.committedDocument;
    const pastedPath = pastedIds
      .map((id) => document.nodes[id])
      .find((node) => node?.type === "path");
    const pastedText = pastedIds
      .map((id) => document.nodes[id])
      .find((node) => node?.type === "text");

    expect(pastedPath?.type).toBe("path");
    expect(pastedText?.type).toBe("text");
    if (pastedPath?.type === "path" && pastedText?.type === "text") {
      expect(pastedText.onPath?.pathId).toBe(pastedPath.id);
      expect(pastedText.onPath?.pathId).not.toBe(path.id);
    }
    const updatedGroup = document.nodes[group.id];
    expect(updatedGroup?.type).toBe("group");
    if (updatedGroup?.type === "group") {
      expect(updatedGroup.children).toEqual(
        expect.arrayContaining(pastedIds),
      );
    }
  });

  it("detaches a pasted text attachment when its path was not copied", () => {
    const { text } = fixture();
    copyNodes([text.id]);
    const [pastedId] = pasteNodes();
    const pasted = documentStore.committedDocument.nodes[pastedId!];
    expect(pasted?.type).toBe("text");
    if (pasted?.type === "text") {
      expect(pasted.onPath).toBeUndefined();
    }
  });
});
