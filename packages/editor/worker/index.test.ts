import { describe, expect, it, vi } from "vitest";
import worker from "./index";

const INDEX_HTML =
  '<meta property="og:image" content="https://openlogo.invalid/og.png">';

function createEnv() {
  return {
    ASSETS: {
      fetch: vi.fn(async (request: Request) => {
        const pathname = new URL(request.url).pathname;
        return pathname === "/"
          ? new Response(INDEX_HTML, {
              headers: {
                "content-type": "text/html",
                etag: '"stale-index-etag"',
              },
            })
          : new Response("asset", {
              headers: { "content-type": "application/javascript" },
            });
      }),
    },
  };
}

describe("Sites worker", () => {
  it.each(["text/html", "*/*", ""])(
    "serves absolute social metadata for %s requests",
    async (accept) => {
      const env = createEnv();
      const response = await worker.fetch(
        new Request("https://openlogo.example/", {
          headers: { accept },
        }),
        env,
      );

      expect(await response.text()).toContain(
        "https://openlogo.example/og.png",
      );
      expect(response.headers.get("etag")).toBeNull();
    },
  );

  it("serves the app shell for extensionless routes", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request("https://openlogo.example/projects/example", {
        headers: { accept: "text/html" },
      }),
      env,
    );

    expect(await response.text()).toContain(
      "https://openlogo.example/og.png",
    );
    expect(env.ASSETS.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://openlogo.example/" }),
    );
  });

  it("passes asset requests through unchanged", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request("https://openlogo.example/assets/app.js", {
        headers: { accept: "*/*" },
      }),
      env,
    );

    expect(await response.text()).toBe("asset");
  });
});
