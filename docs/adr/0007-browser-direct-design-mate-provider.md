# ADR 0007: Design Mate supports browser-direct BYO model providers

- Status: Accepted
- Date: 2026-07-14

## Context

Design Mate originally required a separately configured service endpoint and
environment variables. That protected long-lived provider credentials from the
browser, but made a local-first editor depend on sidecar setup before remote
model guidance could work. Bundling a shared provider key would expose one
credential to every client and is not acceptable.

OpenLogo already constrains model input to a bounded design context, validated
review findings, conversation messages, and up to three PNG previews. Model
output also passes through strict read-only tool dispatch or the proposal
validation and explicit-approval pipeline. These seams allow the model
transport to move without giving it direct access to the raw Logo Document or
canvas mutations.

## Decision

- Users may configure an API key, model name, and base URL in the in-app
  Settings dialog. The validated settings are stored in this browser under
  `openlogo:design-mate-provider`; no environment variable is required.
- Provider base URLs must use HTTPS, except that HTTP is allowed for loopback
  development. Embedded credentials, query strings, and fragments are
  rejected. The configured provider must implement the OpenAI Responses API at
  `<baseUrl>/responses`, including streaming and strict function tools.
- The browser-safe `@openlogo/design-mate` package owns the Responses transport
  behind `DesignMateModelTransport`. `@openlogo/design-mate-service` re-exports
  that transport so existing service deployments remain compatible.
- When AI is enabled, in-app provider settings take precedence over a legacy
  configured service endpoint. Without either provider—or while AI is
  disabled—chat is unavailable. Design Mate never substitutes a synthetic
  local response or proposal after a provider failure; deterministic review
  remains available independently.
- Only messages, bounded design context, deterministic review data, proposal
  memory, and up to three bounded PNG previews cross the provider seam. The raw
  Logo Document is never uploaded.
- Direct model output has no mutation authority. Read-only tool calls are
  allowlisted and bounded; every proposed change must compile against the
  supplied IDs and closed action schema, then wait for explicit user approval.
- `gpt-4.1-mini` is the initial default because the 2026-07-14 live-fire
  bake-off matched full `gpt-4.1` on correctness while preserving the smaller
  model tier. Model choice remains user-configurable and may change without
  superseding this ADR.
- Browser-direct credentials are for a trusted local/browser profile. A public
  multi-user deployment must revisit this decision and prefer a same-origin
  proxy, short-lived credential, or provider OAuth flow.

## Consequences

- Local users can enable model-backed Design Mate without running a sidecar or
  rebuilding OpenLogo, while service-based deployments continue to work.
- Missing configuration and provider failures are explicit chat states rather
  than plausible-looking local answers.
- The configured provider receives the bounded context and previews directly,
  so its data handling, retention, billing, CORS support, and availability
  become user-visible dependencies.
- The API key persists unencrypted in `localStorage` until cleared. Any script
  executing on the OpenLogo origin, a privileged browser extension, or another
  user of the same browser profile may be able to read it.
- “OpenAI-compatible” is intentionally narrower than Chat Completions
  compatibility: providers without the Responses endpoint, SSE event contract,
  image input, and strict tools are unsupported.
- Keeping prompt assembly and transport behind `DesignMateModelTransport`
  preserves one test seam for direct, service, fake, and future authenticated
  adapters.
- Guardrails remain defense in depth. The system prompt guides arbitrary model
  choices, while deterministic validation and user approval remain the actual
  security boundary for canvas changes.
