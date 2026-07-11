# `@openlogo/design-mate-service`

Authenticated, bounded SSE gateway for OpenLogo Design Mate remote chat. It
keeps provider credentials out of the editor, validates every request and model
chunk, and exposes no document-storage API.

## Local quickstart

From the repository root:

```bash
export DESIGN_MATE_PROVIDER_API_KEY="<provider key>"
export DESIGN_MATE_PROVIDER_MODEL="<Responses API model>"
export DESIGN_MATE_ALLOW_ANONYMOUS_LOOPBACK=true
export DESIGN_MATE_SERVICE_ALLOWED_ORIGINS=http://localhost:5174
pnpm dev:design-mate
```

The default address is `http://127.0.0.1:8787`. Anonymous access is restricted
to a loopback listener and loopback clients.

In another shell:

```bash
export VITE_DESIGN_MATE_SERVICE_URL=http://127.0.0.1:8787
pnpm dev
```

Then enable remote AI in the editor's Design Mate consent panel.

## Build and run

Node.js 22 or newer is required.

```bash
pnpm build:design-mate-service
pnpm --filter @openlogo/design-mate-service start
```

Production deployments must set a service token or inject a custom
`RequestAuth`; anonymous loopback mode is for local development only. Never
ship the service token or provider key in browser code.

## Endpoints

- `GET /health` — unauthenticated health/version response
- `POST /v1/design-mate/chat` — authenticated JSON request and SSE response
- `OPTIONS` — strict origin-aware preflight

## Checks

```bash
pnpm --filter @openlogo/design-mate-service test
pnpm smoke:design-mate-service
```

See [`docs/DESIGN_MATE.md`](../../docs/DESIGN_MATE.md) for every environment
setting, browser authentication patterns, CORS, privacy, limits, logging,
shutdown, and deployment guidance. [`.env.example`](.env.example) is a
reference only; the executable does not load it automatically.
