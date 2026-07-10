import { createInitialDocument } from "@openlogo/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  canvasToRasterBlob,
  downloadRasterFromSvg,
  drawRasterImage,
  MAX_RASTER_DIMENSION,
} from "./export";
import {
  DEFAULT_JPEG_QUALITY,
  DEFAULT_RASTER_BACKGROUND,
  DEFAULT_WEBP_QUALITY,
  type ExportRequest,
  type ExportScope,
  type ExportTarget,
  buildExportTargets,
  filenameSlug,
  preflightRasterTargets,
  uniqueSlugs,
} from "./export-jobs";

const target: ExportTarget = {
  slug: "brand-mark",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" />',
  width: 720,
  height: 420,
};

function rasterRequest(
  format: "png" | "jpeg" | "webp",
  overrides: Record<string, unknown> = {},
): Extract<ExportRequest, { format: typeof format }> {
  const common = {
    scope: "active" as const,
    selectionIds: [] as string[],
  };
  if (format === "png") {
    return {
      ...common,
      format,
      settings: {
        scale: 2,
        customWidth: 1024,
        transparentBackground: false,
        backgroundColor: DEFAULT_RASTER_BACKGROUND,
        ...overrides,
      },
    } as Extract<ExportRequest, { format: typeof format }>;
  }
  if (format === "jpeg") {
    return {
      ...common,
      format,
      settings: {
        scale: 2,
        customWidth: 1024,
        quality: DEFAULT_JPEG_QUALITY,
        backgroundColor: DEFAULT_RASTER_BACKGROUND,
        ...overrides,
      },
    } as Extract<ExportRequest, { format: typeof format }>;
  }
  return {
    ...common,
    format,
    settings: {
      scale: 2,
      customWidth: 1024,
      quality: DEFAULT_WEBP_QUALITY,
      transparentBackground: true,
      backgroundColor: DEFAULT_RASTER_BACKGROUND,
      ...overrides,
    },
  } as Extract<ExportRequest, { format: typeof format }>;
}

describe("raster export planning", () => {
  it("plans deterministic JPEG dimensions, filename, MIME, quality, and background", () => {
    const result = preflightRasterTargets([target], rasterRequest("jpeg"));
    expect(result).toEqual({
      ok: true,
      plans: [
        {
          ...target,
          filename: "brand-mark@2x.jpg",
          scale: 2,
          pixelWidth: 1440,
          pixelHeight: 840,
          encoding: {
            mimeType: "image/jpeg",
            quality: 0.9,
            backgroundColor: "#ffffff",
          },
        },
      ],
    });
  });

  it("plans transparent WebP at a custom width without an opaque underlay", () => {
    const result = preflightRasterTargets(
      [target],
      rasterRequest("webp", {
        scale: "custom",
        customWidth: 1000,
        quality: 0.85,
        transparentBackground: true,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      plans: [
        {
          filename: "brand-mark-1000px.webp",
          pixelWidth: 1000,
          pixelHeight: 583,
          encoding: { mimeType: "image/webp", quality: 0.85 },
        },
      ],
    });
    if (result.ok) {
      expect(result.plans[0]!.encoding).not.toHaveProperty("backgroundColor");
    }
  });

  it("plans PNG with lossless MIME and an explicit opaque background", () => {
    const result = preflightRasterTargets(
      [target],
      rasterRequest("png", { scale: 1, backgroundColor: "#F8FAFC" }),
    );
    expect(result).toMatchObject({
      ok: true,
      plans: [
        {
          filename: "brand-mark.png",
          pixelWidth: 720,
          pixelHeight: 420,
          encoding: {
            mimeType: "image/png",
            backgroundColor: "#f8fafc",
          },
        },
      ],
    });
    if (result.ok) {
      expect(result.plans[0]!.encoding).not.toHaveProperty("quality");
    }
  });

  it("accepts only bounded lossy quality values", () => {
    expect(
      preflightRasterTargets(
        [target],
        rasterRequest("jpeg", { quality: 0.1 }),
      ).ok,
    ).toBe(true);
    expect(
      preflightRasterTargets(
        [target],
        rasterRequest("webp", { quality: 1 }),
      ).ok,
    ).toBe(true);
    expect(
      preflightRasterTargets(
        [target],
        rasterRequest("jpeg", { quality: 0.09 }),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("10%") });
    expect(
      preflightRasterTargets(
        [target],
        rasterRequest("webp", { quality: 1.01 }),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("100%") });
  });

  it("requires a safe explicit JPEG background", () => {
    expect(
      preflightRasterTargets(
        [target],
        rasterRequest("jpeg", { backgroundColor: "transparent" }),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("hex color") });
    expect(
      preflightRasterTargets(
        [target],
        rasterRequest("jpeg", { backgroundColor: undefined }),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("hex color") });
  });

  it("rejects an entire batch before returning partial plans", () => {
    const oversized: ExportTarget = {
      ...target,
      slug: "too-large",
      width: MAX_RASTER_DIMENSION + 1,
      height: 1,
    };
    const result = preflightRasterTargets(
      [target, oversized],
      rasterRequest("png", { scale: 1 }),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("too large"),
    });
    expect(result).not.toHaveProperty("plans");
  });

  it("sanitizes and deduplicates stable filenames", () => {
    expect(filenameSlug("  Café / Primary™  ")).toBe("cafe-primary");
    expect(filenameSlug("---")).toBe("artboard");
    const document = createInitialDocument();
    const boards = [
      { ...document.artboards[0]!, name: "Logo / Primary" },
      { ...document.artboards[0]!, id: "board-2", name: "Logo Primary" },
      { ...document.artboards[0]!, id: "board-3", name: "Logo Primary 2" },
      { ...document.artboards[0]!, id: "board-4", name: "!!!" },
    ];
    expect(uniqueSlugs(boards)).toEqual([
      "logo-primary",
      "logo-primary-2",
      "logo-primary-2-2",
      "artboard",
    ]);
  });
});

describe("raster scope parity", () => {
  it.each(["png", "jpeg", "webp"] as const)(
    "builds active, all-board, and selection targets for %s",
    async (format) => {
      const document = createInitialDocument();
      const selectedNodeId = document.artboards[0]!.nodeIds[0]!;

      for (const scope of ["active", "all", "selection"] as ExportScope[]) {
        const request = {
          ...rasterRequest(format),
          scope,
          selectionIds: [selectedNodeId],
        } as Extract<ExportRequest, { format: typeof format }>;
        const targets = await Effect.runPromise(
          buildExportTargets(document, request),
        );
        expect(targets).toHaveLength(
          scope === "all" ? document.artboards.length : 1,
        );
        if (scope === "selection") {
          expect(targets[0]!.slug).toBe("selection");
        }
      }
    },
  );

  it("removes board background only for transparent-capable exports", async () => {
    const document = createInitialDocument();
    const opaqueJpeg = await Effect.runPromise(
      buildExportTargets(document, rasterRequest("jpeg")),
    );
    const transparentWebp = await Effect.runPromise(
      buildExportTargets(document, rasterRequest("webp")),
    );
    expect(opaqueJpeg[0]!.svg).toContain('<rect width="100%"');
    expect(transparentWebp[0]!.svg).not.toContain('<rect width="100%"');
  });
});

describe("raster canvas encoding", () => {
  it("passes exact MIME and bounded quality to the encoder", async () => {
    const calls: unknown[][] = [];
    const canvas = {
      toBlob(
        callback: BlobCallback,
        mimeType?: string,
        quality?: number,
      ) {
        calls.push([mimeType, quality]);
        callback(new Blob(["webp"], { type: mimeType ?? "" }));
      },
    } as HTMLCanvasElement;

    const blob = await Effect.runPromise(
      canvasToRasterBlob(canvas, {
        mimeType: "image/webp",
        quality: 0.85,
      }),
    );
    expect(calls).toEqual([["image/webp", 0.85]]);
    expect(blob.type).toBe("image/webp");
  });

  it("preserves failure when encoding returns null or silently falls back", async () => {
    const nullCanvas = {
      toBlob(callback: BlobCallback) {
        callback(null);
      },
    } as HTMLCanvasElement;
    const nullFailure = await Effect.runPromise(
      Effect.flip(
        canvasToRasterBlob(nullCanvas, { mimeType: "image/jpeg", quality: 0.9 }),
      ),
    );
    expect(nullFailure).toMatchObject({
      _tag: "ExportError",
      reason: "JPEG encoding failed.",
    });

    const fallbackCanvas = {
      toBlob(callback: BlobCallback) {
        callback(new Blob(["png fallback"], { type: "image/png" }));
      },
    } as HTMLCanvasElement;
    const fallbackFailure = await Effect.runPromise(
      Effect.flip(
        canvasToRasterBlob(fallbackCanvas, {
          mimeType: "image/webp",
          quality: 0.85,
        }),
      ),
    );
    expect(fallbackFailure).toMatchObject({
      _tag: "ExportError",
      reason: expect.stringContaining("not supported"),
    });
  });

  it("rejects an uncomposited JPEG before canvas or DOM work", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        downloadRasterFromSvg(
          target.svg,
          "unsafe.jpg",
          target.width,
          target.height,
          1,
          { mimeType: "image/jpeg", quality: 0.9 },
        ),
      ),
    );
    expect(failure).toMatchObject({
      _tag: "ExportError",
      reason: expect.stringContaining("explicit background"),
    });
  });

  it("rejects out-of-range encoder quality without calling the encoder", async () => {
    let called = false;
    const canvas = {
      toBlob() {
        called = true;
      },
    } as unknown as HTMLCanvasElement;
    const failure = await Effect.runPromise(
      Effect.flip(
        canvasToRasterBlob(canvas, { mimeType: "image/webp", quality: 0.01 }),
      ),
    );
    expect(failure).toMatchObject({
      _tag: "ExportError",
      reason: expect.stringContaining("10%"),
    });
    expect(called).toBe(false);
  });

  it("paints an explicit background before the SVG source", () => {
    const events: string[] = [];
    const context = {
      set fillStyle(value: string | CanvasGradient | CanvasPattern) {
        events.push(`fillStyle:${String(value)}`);
      },
      fillRect(x: number, y: number, width: number, height: number) {
        events.push(`fillRect:${x},${y},${width},${height}`);
      },
      drawImage(
        _image: CanvasImageSource,
        x: number,
        y: number,
        width: number,
        height: number,
      ) {
        events.push(`drawImage:${x},${y},${width},${height}`);
      },
    } as unknown as CanvasRenderingContext2D;

    drawRasterImage(
      context,
      {} as CanvasImageSource,
      1440,
      840,
      "#ffffff",
    );
    expect(events).toEqual([
      "fillStyle:#ffffff",
      "fillRect:0,0,1440,840",
      "drawImage:0,0,1440,840",
    ]);
  });
});
