# Design Mate

Design Mate is OpenLogo's design-assistance layer. It combines deterministic
logo checks, canvas-linked findings, previewable vector proposals, and bounded
chat. The editor remains manual-first: suggestions never mutate the live
document until the user approves them, and an approved proposal is one atomic
undo step.

## Components and trust boundaries

- `@openlogo/core` owns deterministic review rules and the logo document.
- `@openlogo/design-mate` builds bounded context, validates chat data, prepares
  proposals against detached document snapshots, and rejects stale changes.
- `@openlogo/editor` captures optional PNG previews, asks for remote-AI consent,
  and applies approved commands through the normal document history.
- `@openlogo/design-mate-service` is a Node.js gateway. It authenticates and
  limits requests, calls the configured OpenAI Responses-compatible provider,
  and streams validated Server-Sent Events (SSE) back to the editor.

The full `LogoDocument` never crosses the remote chat boundary. The editor
creates a wire-safe request without the detached document snapshot, and both
the client and service validate that request before use.

## Without a chat provider

No service is required for deterministic review or its locally generated,
previewable suggestions. Chat requires either an in-app provider configuration
or `VITE_DESIGN_MATE_SERVICE_URL`. Without one, the composer is disabled and
Design Mate shows setup guidance; it never fabricates a model response.

## Local development with remote AI

The simplest local setup is **Settings → Design Mate** in the editor. Enter a
provider API key, model, and Responses API base URL. The key stays in this
browser's `localStorage` and is sent directly to that provider. Use the gateway
below when the provider key must remain outside the browser.

The service does not automatically read `.env` files. Export values in the
shell or configure them in the process manager.

```bash
# Terminal 1: authenticated provider gateway on loopback.
export DESIGN_MATE_PROVIDER_API_KEY="<provider key>"
export DESIGN_MATE_PROVIDER_MODEL="<Responses API model>"
export DESIGN_MATE_ALLOW_ANONYMOUS_LOOPBACK=true
export DESIGN_MATE_SERVICE_ALLOWED_ORIGINS=http://localhost:5174
pnpm dev:design-mate

# Terminal 2: editor.
export VITE_DESIGN_MATE_SERVICE_URL=http://127.0.0.1:8787
pnpm dev
```

Open `http://localhost:5174`, open Design Mate, and select **Enable remote AI**.
The consent setting defaults to off and is stored locally.

Anonymous mode is accepted only when the service binds to a loopback host and
the request also comes from loopback. Never enable it on a public listener.

## Editor configuration and consent

`VITE_DESIGN_MATE_SERVICE_URL` is a Vite build-time setting. It accepts:

- an HTTPS service root, such as `https://ai.example.com`;
- loopback HTTP for development, such as `http://127.0.0.1:8787`; or
- a root-relative same-origin proxy path, such as `/api/design-mate`.

OpenLogo appends `/v1/design-mate/chat` unless that route is already present.
Remote non-HTTPS URLs, URL credentials, fragments, protocol-relative URLs, and
invalid values are rejected and leave chat unavailable.

A configured URL only makes model-backed chat available. The editor still
requires explicit user consent. The `designMateRemoteEnabled` preference
defaults to `false`; turning it off disables chat without affecting
deterministic review.

The stock editor does not contain a service credential. A host integration can
install an in-memory, short-lived token callback at bootstrap:

```ts
import { setDesignMateAccessTokenProvider } from "./lib/design-mate-chat";

setDesignMateAccessTokenProvider((signal) =>
  session.getDesignMateAccessToken({ signal }),
);
```

The callback—not the token—is retained. Do not put
`DESIGN_MATE_SERVICE_TOKEN` or any provider key in a `VITE_*` variable.

## Production deployment

The executable requires Node.js 22 or newer.

```bash
pnpm install --frozen-lockfile
pnpm build:design-mate-service
pnpm --filter @openlogo/design-mate-service start
```

The bundled entry point is
`packages/design-mate-service/dist/server.js`; the package also exposes the
`openlogo-design-mate` binary after packaging.

For production:

1. Terminate TLS at the service or a trusted reverse proxy.
2. Require authentication. The standalone executable supports one bearer token
   through `DESIGN_MATE_SERVICE_TOKEN`. A programmatic deployment can inject a
   `RequestAuth` implementation for per-user sessions.
3. Prefer a same-origin backend proxy that authenticates the user and adds the
   service bearer token server-side. If the browser calls the gateway directly,
   install a short-lived token provider and use injected service authentication;
   do not distribute the standalone static token to an untrusted browser.
4. Set `DESIGN_MATE_SERVICE_ALLOWED_ORIGINS` to every exact browser origin for
   direct cross-origin requests. Requests with an `Origin` header that is not in
   the allowlist receive `403`.
5. Keep the provider key only in the service environment.
6. Run at least two instances behind a load balancer if process availability is
   required. Rate and concurrency state is intentionally process-local.

### Service settings

`DESIGN_MATE_PROVIDER_API_KEY` and `DESIGN_MATE_PROVIDER_MODEL` are always
required by the executable. Authentication additionally requires
`DESIGN_MATE_SERVICE_TOKEN`, or the explicit loopback-only development setting.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DESIGN_MATE_SERVICE_HOST` | `127.0.0.1` | Listen host |
| `DESIGN_MATE_SERVICE_PORT` | `8787` | Listen port |
| `DESIGN_MATE_SERVICE_TOKEN` | none | Standalone bearer credential |
| `DESIGN_MATE_ALLOW_ANONYMOUS_LOOPBACK` | `false` | Explicit local-development auth bypass |
| `DESIGN_MATE_SERVICE_ALLOWED_ORIGINS` | empty | Comma-separated exact HTTP(S) browser origins |
| `DESIGN_MATE_SERVICE_MAX_BODY_BYTES` | `5242880` | Request body ceiling |
| `DESIGN_MATE_SERVICE_MAX_JSON_DEPTH` | `32` | Parsed JSON nesting ceiling |
| `DESIGN_MATE_SERVICE_RATE_LIMIT_REQUESTS_PER_MINUTE` | `30` | Fixed-window limit per authenticated subject |
| `DESIGN_MATE_SERVICE_MAX_CONCURRENT_REQUESTS` | `16` | Process-wide active chat limit |
| `DESIGN_MATE_SERVICE_MAX_CONCURRENT_REQUESTS_PER_SUBJECT` | `4` | Per-subject active chat limit |
| `DESIGN_MATE_SERVICE_REQUEST_TIMEOUT_MS` | `90000` | Whole request deadline |
| `DESIGN_MATE_SERVICE_UPSTREAM_TIMEOUT_MS` | `60000` | Provider deadline |
| `DESIGN_MATE_SERVICE_UPSTREAM_RETRY_ATTEMPTS` | `1` | Pre-stream retry count (`0`–`2`) |
| `DESIGN_MATE_PROVIDER_API_KEY` | required | Provider credential |
| `DESIGN_MATE_PROVIDER_MODEL` | required | Responses API model |
| `DESIGN_MATE_PROVIDER_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API root |
| `DESIGN_MATE_PROVIDER_IMAGE_DETAIL` | `auto` | `auto` or `low` |
| `DESIGN_MATE_PROVIDER_MAX_OUTPUT_TOKENS` | `1200` | Provider output ceiling |

The shorter aliases without `SERVICE_` are retained for host, port, allowed
origins, body/depth/rate/concurrency limits, timeouts, and retry attempts.
Conflicting canonical and alias values fail startup.

Reference files:

- `packages/design-mate-service/.env.example`
- `packages/editor/.env.example`

## HTTP and operations

| Route | Method | Authentication | Result |
| --- | --- | --- | --- |
| `/health` | `GET` | none | `{"status":"ok","version":"0.1.0"}` |
| `/v1/design-mate/chat` | `POST` | required outside explicit loopback mode | Validated SSE chat stream |
| either route | `OPTIONS` | CORS policy | Preflight response |

Responses disable caching and set `X-Content-Type-Options: nosniff`. Request
bodies, JSON depth, request rate, concurrency, model time, SSE frames, and total
stream bytes are bounded. The service retries only retryable provider failures
before the first streamed chunk; it never replays a partially delivered answer.

SIGINT and SIGTERM stop accepting work and allow active connections to drain.
The executable force-closes remaining connections after 30 seconds.

Lifecycle and request logs are JSON lines. Request logs include schema version,
route, status, duration, provider/error metadata, and HMAC-hashed subject,
conversation, and turn identifiers. The random HMAC key is process-local, so
those hashes are useful for one process lifetime but are not stable identifiers.
Prompt text, document context, and image bytes are not written to service logs.

## Privacy and persistence

Remote AI is opt-in. When enabled, one chat request can contain:

- the current user message and up to 24 bounded history messages;
- up to 32 bounded proposal-outcome memory events;
- structured design context and deterministic review findings;
- selection and document identity metadata; and
- up to three PNG previews of the selection, active artboard, or overview.

Each PNG is at most 700 KiB, between 32 and 1024 pixels per side, and at most
one million pixels. The complete wire request is capped at 5 MiB. The service
also verifies PNG headers instead of trusting claimed dimensions.

OpenLogo does not persist remote requests on the gateway. The browser stores:

- `openlogo:prefs` in `localStorage`, including AI consent and review scope;
- `openlogo:design-mate-provider` in `localStorage` when browser-direct chat is
  configured, including its API key, model, and base URL; and
- `openlogo:design-mate:transcript:<document-id>` in `sessionStorage`, capped at
  128 KiB and available only for the current browser tab.

Clearing the conversation removes its session entry. Restored transcript
entries intentionally omit document identity context, so an old answer cannot
be treated as current. The local document library remains in IndexedDB and is
not uploaded by Design Mate.

The configured model provider receives the validated remote payload and applies
its own retention and training policy. A production operator must disclose that
provider and configure its retention controls appropriately.

## Failure behavior

- Invalid, oversized, stale, or no-op proposals are rejected before they reach
  the live document.
- Approved proposals are rechecked against document identity and revision.
- Authentication, origin, provider, rate-limit, and timeout failures are shown
  to the user. Chat never substitutes a synthetic local answer.
- Users can stop review or chat work. Abort signals propagate through preview
  capture, authentication, transport, and provider execution.

## Verification

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:editor
pnpm smoke:design-mate-service
```

`smoke:editor` launches the production build in headless Chrome/Chromium,
verifies document and CanvasKit readiness at desktop and 390 px, opens the
lazy-loaded Design Mate panel, and checks Escape/focus restoration. CI builds
with a safe relative service URL and additionally verifies that AI consent is
still off. The service smoke starts the bundled executable and validates
`/health`; HTTP/SSE/authentication behavior is covered by the service integration
tests.
