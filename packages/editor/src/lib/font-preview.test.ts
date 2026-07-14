import { afterEach, describe, expect, it, vi } from "vitest";
import type { FontFamily } from "./font-catalog";
import {
  ensurePreview,
  ensurePreviewFace,
  isPreviewFaceReady,
  isPreviewReady,
} from "./font-preview";

const exactFamily: FontFamily = {
  name: "Exact Preview Test",
  id: "exact-preview-test",
  weights: [400, 700],
  styles: ["normal", "italic"],
  category: "sans",
};

class TestFontFace {
  static instances: TestFontFace[] = [];

  constructor(
    readonly family: string,
    readonly source: string,
    readonly descriptors: FontFaceDescriptors,
  ) {
    TestFontFace.instances.push(this);
  }

  load(): Promise<TestFontFace> {
    return Promise.resolve(this);
  }
}

describe("font preview faces", () => {
  afterEach(() => {
    TestFontFace.instances = [];
    vi.unstubAllGlobals();
  });

  it("deduplicates and registers the nearest exact face", async () => {
    const add = vi.fn();
    vi.stubGlobal("FontFace", TestFontFace);
    vi.stubGlobal("document", { fonts: { add } });

    const first = ensurePreviewFace(exactFamily, 650, "italic");
    const second = ensurePreviewFace(exactFamily, 650, "italic");

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(TestFontFace.instances).toHaveLength(1);
    expect(TestFontFace.instances[0]).toMatchObject({
      family: exactFamily.name,
      source: expect.stringContaining("latin-700-italic.woff2"),
      descriptors: { weight: "700", style: "italic" },
    });
    expect(add).toHaveBeenCalledOnce();
    expect(isPreviewFaceReady(exactFamily, 650, "italic")).toBe(true);
  });

  it("preserves the picker default-face API", async () => {
    const family = { ...exactFamily, name: "Default Preview Test" };
    vi.stubGlobal("FontFace", TestFontFace);
    vi.stubGlobal("document", { fonts: { add: vi.fn() } });

    ensurePreview(family);
    await ensurePreviewFace(family, 400);

    expect(isPreviewReady(family.name)).toBe(true);
  });
});
