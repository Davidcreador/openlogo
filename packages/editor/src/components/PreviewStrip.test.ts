import { createInitialDocument } from "@openlogo/core";
import { describe, expect, it } from "vitest";
import {
  PREVIEW_SIZES,
  productionPreviewSvg,
  type PreviewSurface,
} from "./PreviewStrip";

describe("production previews", () => {
  it("covers standard favicon and small-logo widths", () => {
    expect(PREVIEW_SIZES).toEqual([128, 64, 48, 32, 16]);
  });

  it("keeps the artboard background only in the artboard context", () => {
    const document = createInitialDocument();
    const background = document.artboards[0]!.background;

    expect(productionPreviewSvg(document, "artboard")).toContain(
      `<rect width="100%" height="100%" fill="${background}" />`,
    );

    for (const surface of [
      "light",
      "dark",
      "transparent",
    ] satisfies PreviewSurface[]) {
      expect(productionPreviewSvg(document, surface)).not.toContain(
        '<rect width="100%" height="100%"',
      );
    }
  });
});
