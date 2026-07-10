# Performance workflow

OpenLogo treats performance as a release property with repeatable inputs, not
as a claim inferred from CanvasKit or bundle size.

## Fixed model fixtures

Run:

```bash
pnpm bench
```

The core benchmark covers a typical 500-leaf logo document and a 10,000-leaf
stress document. It measures cold scene flattening, cached scene reads, schema
validation/migration, and a 100-node commit plus undo. Fixtures are generated
deterministically at a fixed density in
`packages/core/bench/editor-model.bench.ts`.

Local baseline captured 2026-07-09 (use for regression direction, not as a
cross-machine SLA):

| Operation | Fixture | Mean |
| --- | ---: | ---: |
| Cold scene flatten | 500 leaves | 0.022 ms |
| Validate/migrate JSON | 500 leaves | 0.99 ms |
| Commit + undo transform | 100 of 500 leaves | 0.16 ms |
| Cold scene flatten | 10,000 leaves | 1.37 ms |
| Validate/migrate JSON | 10,000 leaves | 27.26 ms |

The stress flatten benchmark is allocation-sensitive and showed GC outliers;
track p99 alongside the mean before treating a change as an improvement.

## Browser startup marks

Production code emits navigation-relative User Timing entries:

- `openlogo:time-to-document`
- `openlogo:time-to-renderer`
- `openlogo:time-to-editor`

In development, inspect the normalized values with:

```js
window.__openlogo.getStartupMetrics()
```

Document readiness and renderer readiness are measured separately so an
IndexedDB regression is not confused with WASM compilation. The whole-editor
mark exists only after both are ready.

Warm development-browser baseline captured 2026-07-09 after the CanvasKit and
font caches were populated (four reloads on the review machine):

| Mark | Median | Range |
| --- | ---: | ---: |
| Document ready | 158 ms | 149-195 ms |
| Whole editor ready | 224 ms | 219-257 ms |

This is a local regression reference, not a fixed-runner SLA. The matching
production build reported a 191.7 KiB editor entry, 814.0 KiB of initial
JavaScript across ten chunks, and 6.77 MiB of CanvasKit WASM.

Document Library, Export, and Transform are lazy first-use chunks. Once opened,
each stays mounted so repeated use preserves state and avoids reload churn.

## Release interpretation

- Bundle budgets prevent accidental transfer/execution cliffs, but do not
  prove runtime responsiveness.
- Model benchmarks catch command, migration, and scene-query regressions.
- Browser journeys must still measure cold startup and repeatable warm startup
  with fixed-runner provenance, plus frame p95 during transforms, memory, and
  raster export cancellation.
- Never tighten a timing budget from a single local run. Record runner, browser,
  fixture, sample count, mean, and p95/p99.
