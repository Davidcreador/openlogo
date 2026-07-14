import { createInitialDocument } from "@openlogo/core";
import { describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_THUMBNAIL_LONGEST_EDGE,
  renderDocumentThumbnail,
} from "./document-thumbnail";

describe("renderDocumentThumbnail", () => {
  it("renders the active artboard as a 320px-longest-edge PNG data URL", async () => {
    const document = createInitialDocument();
    document.artboards[0]!.width = 640;
    document.artboards[0]!.height = 320;
    const renderArtboard = vi.fn(() => "<svg>artboard</svg>");
    const embedFonts = vi.fn(async (svg: string) => `${svg}:embedded`);
    const rasterizePng = vi.fn(async () =>
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    );

    const dataUrl = await renderDocumentThumbnail(document, {
      renderArtboard,
      embedFonts,
      rasterizePng,
    });

    expect(renderArtboard).toHaveBeenCalledWith(
      document,
      document.artboards[0],
    );
    expect(embedFonts).toHaveBeenCalledWith("<svg>artboard</svg>", document);
    expect(rasterizePng).toHaveBeenCalledWith(
      "<svg>artboard</svg>:embedded",
      640,
      320,
      DOCUMENT_THUMBNAIL_LONGEST_EDGE / 640,
    );
    expect(dataUrl).toBe("data:image/png;base64,iVBORw==");
  });
});
