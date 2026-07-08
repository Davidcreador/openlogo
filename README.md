# OpenLogo

OpenLogo is an early manual-first logo design studio prototype. The product direction is a focused logo platform that combines Kittl-style approachability, Illustrator-inspired vector control, and an agent that acts as a helpful design mate instead of replacing the manual process.

## Current prototype

This first implementation establishes the browser-based editor foundation:

- SVG artboard canvas with grid
- Manual tools for selection, rectangles, ellipses, starter marks, and wordmarks
- Move and resize interactions
- Fill, opacity, rotation, and typography property controls
- Layer selection panel
- Logo system artboard variants: icon, wordmark, horizontal, stacked
- Small-size preview strip for 128px, 64px, 32px, and 16px checks
- SVG and PNG export
- Local "design mate" review pass for early logo craft checks
- Undo/redo for document mutations

## Development

```bash
npm install
npm run dev
```

Build the production bundle:

```bash
npm run build
```

## Implementation direction

The next major areas are:

1. Real pen and Bezier node editing
2. Boolean/pathfinder operations
3. Snapping, guides, optical alignment, and construction helpers
4. Stronger typography workflow with font browsing and text-to-path
5. Non-destructive agent tools for critique, cleanup, variations, and export prep
6. Production export packs with dark/light/mono variants and brand guidelines
