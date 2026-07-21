const OG_IMAGE_PLACEHOLDER = "https://openlogo.invalid/og.png";

type Env = {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
};

function isDocumentRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  const finalSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  const accept = request.headers.get("accept") ?? "";
  const acceptsDocument =
    accept.length === 0 ||
    accept
      .split(",")
      .map((value) => value.split(";", 1)[0]?.trim())
      .some((value) => value === "text/html" || value === "*/*");
  return (
    request.method === "GET" &&
    (request.mode === "navigate" ||
      acceptsDocument) &&
    !finalSegment.includes(".")
  );
}

async function serveDocument(request: Request, env: Env): Promise<Response> {
  const requestUrl = new URL(request.url);
  const response = await env.ASSETS.fetch(
    new Request(new URL("/", requestUrl), request),
  );
  if (!response.ok) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("etag");
  headers.set("cache-control", "no-cache");
  return new Response(
    (await response.text()).replaceAll(
      OG_IMAGE_PLACEHOLDER,
      `${requestUrl.origin}/og.png`,
    ),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return isDocumentRequest(request)
      ? serveDocument(request, env)
      : env.ASSETS.fetch(request);
  },
};
