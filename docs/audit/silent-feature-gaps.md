# Silent feature-gap audit

> **Status update (2026-07-14, post-remediation):** All 20 findings addressed the same day across five fix batches (text stroke + F01 stroke.align; F02/F04/F15/F16/F17 + F20 markers; F03/F05/F06/F07; F08/F09/F10/F11/F18; F12/F13/F14/F19). Line numbers below reference the pre-fix tree. Still intentionally out of scope: full lossless group-hierarchy round-trip (F20 core), parametric shape identity on import, clipping-mask release appearance; importer now warns instead of silently dropping. Text SVG stroke-align masks depend on target-renderer font availability — CanvasKit stays source of truth.

Date: 2026-07-14  
Scope: `packages/core/src/types.ts`, CanvasKit rendering/hit-testing/bounds, SVG export, SVG import round-trip, and Inspector controls.  
Constraint: read-only repository audit. No repository files were changed.

## Executive summary

This audit found 20 verified gaps. The most serious are:

1. `Stroke.align` is exposed for every leaf type but is ignored by CanvasKit, SVG export, hit-testing, and paint bounds.
2. SVG import loses every exported `PathNode` stroke because path export puts the stroke on a wrapper `<g>` while import reads stroke only from the leaf `<path>`.
3. Text-on-path selection and hit-testing use the text node's stale box while rendering follows the live referenced path.
4. SVG import silently skips all text, including text-on-path and every typography property.
5. Text-on-path exposes alignment, line height, and OpenType controls that its CanvasKit path does not implement; alignment and multiline layout are also absent from SVG text-path output.

The known text-stroke-on-canvas defect is deliberately excluded. Gradient stroke on text was still checked: SVG export emits it, Inspector can set it, and SVG import loses it because import skips all text. No separate CanvasKit finding is reported for that known defect.

## Severity scale

- **S1 — user-visible silent failure:** a control or stored property appears accepted but its visual/interaction result is missing, or export/import silently changes visible output.
- **S2 — cosmetic or interaction mismatch:** output exists but differs across consumers, or bounds/edit affordances disagree with painted pixels.
- **S3 — benign/intentional semantic loss:** visual output is normally preserved, but editor metadata or editability is not. Included for matrix completeness.

## Feature × consumer matrix

Legend: **OK** = consumed; **GAP** = verified gap detailed below; **LOSS** = import/export round-trip loses semantics; **N/A** = intentionally not a visual property; **EXCLUDED** = known defect excluded by request.

| Model field / feature | CanvasKit renderer | SVG export | SVG import round-trip | Hit-testing / selection bounds | Inspector |
|---|---|---|---|---|---|
| `id` | Used for caches/relations | Not preserved as node identity | Regenerated | Used for selection/ancestry | Indirect |
| `name` | N/A | Group only as `data-name`; leaf names omitted | Regenerated | N/A | Layer UI supports naming | 
| `x`, `y`, `width` | OK | OK | Geometry baked/refitted | OK, except text-on-path | Exposed |
| `height` | OK for shapes; **GAP for text rendering** | OK for shapes; **GAP for text rendering** | Geometry baked/refitted | Text uses box, not rendered metrics | Exposed |
| `rotation` | OK | OK | Baked into imported path; field reset to `0` | OK for ordinary leaves; **GAP for text-on-path path rotation** | Exposed |
| leaf `opacity` | OK | OK | **GAP at zero** | Geometry remains hittable at zero opacity | Exposed |
| group `opacity` | Cascades per leaf | **GAP: isolated group opacity** | Cascades, except zero clamp | Bounds unaffected | Exposed |
| `visible` | OK, including group cascade | Hidden nodes omitted | Hidden state cannot round-trip; imported nodes forced visible | **GAP: hidden children still affect group/export bounds** | Layers control |
| `locked` | N/A to paint | Not encoded | Forced unlocked | OK, including ancestor lock cascade | Layers control |
| solid fill | OK | OK | OK for supported shapes | Fill geometry used | Exposed |
| linear fill: `angle`, `start`, `end`, stops, stop `alpha` | OK when endpoint pair is complete | OK when endpoint pair is complete | **LOSS: fallback solid** | N/A | Fill fully editable; paired-coordinate caveat |
| radial fill: `cx`, `cy`, `r`, `fx`, `fy`, stops, stop `alpha` | OK when focal pair is complete | OK when focal pair is complete | **LOSS: fallback solid** | N/A | Fill fully editable via paint UI + G tool |
| stroke `color`, `width`, solid `paint` | OK on shapes; text Canvas defect excluded | OK | **GAP for exported paths** | **GAP outside node box** | Exposed |
| gradient stroke `paint` | OK on non-text shapes; text Canvas defect excluded | OK, including text | **LOSS** | Same geometry gap as solid stroke | Exposed, but stroke gradient geometry has an Inspector gap |
| stroke `align` | **GAP** | **GAP** | Forced to `center` | **GAP** | Exposed on all leaves |
| `blendMode` | OK for leaves, groups, and text-on-path | OK for leaves, groups, and text-on-path | **LOSS** | N/A | Exposed for leaves and groups |
| all four `effects[]` types | OK for leaves, text, groups | Generally emitted; **GAP for filter bounds and clipped groups** | **LOSS** | Paint bounds include enabled bleed; selection geometry intentionally does not | Exposed for every node type |
| rectangle `cornerRadius` | OK | OK | Visual geometry retained as path; property/type lost | **GAP: hit-test uses square box** | Exposed |
| path `d`, intrinsic dimensions, `fillRule` | OK | OK | Visual path and fill rule retained | OK for filled area | `fillRule` exposed; path editing handles `d` |
| path `geometry` | `d` is consumed instead, by design | `d` used; geometry additionally used to reverse text paths | Reconstructed when possible | `d` used | Path-edit UI |
| path `shape.kind`, `sides`, `innerRatio` | Derived `d` consumed, by design | Derived `d` consumed | **LOSS: parametric identity lost** | Derived `d` used | Polygon/star params exposed; kind chosen by tools |
| normal text `content`, family, size, weight, style, spacing, line height, align, kerning, OT features | OK | OK | **LOSS: all text skipped** | Box-based, not glyph/paragraph based | Exposed; kerning edited on canvas |
| text-on-path `pathId`, `startOffset`, `flip` | OK | OK; d-only flip has portability degradation | **LOSS: all text skipped** | **GAP: referenced path transform not followed** | Attach/offset/flip/detach exposed |
| text-on-path `align` | **GAP** | **GAP** | Text skipped | Box-based | Control remains enabled |
| text-on-path `lineHeight` / multiline content | **GAP** | **GAP** | Text skipped | Box-based | Control/content remain enabled |
| text-on-path `otFeatures` | **GAP** | OK | Text skipped | N/A | Ligature/discretionary/small-cap controls remain enabled |
| text-on-path `kerning`, `letterSpacing`, font style/weight | OK | OK | Text skipped | N/A | Exposed/indirect |
| group `children` hierarchy | OK | OK | **LOSS: ordinary groups flattened** | Group derived bounds | Group/layer UI |
| group `clippingMaskId` | OK | OK for supported non-text masks | Simple OpenLogo clip groups reconstructed | Clip ancestry checked | Make/release UI |
| clipping-mask node appearance | Suppressed while owned; retained in model | **LOSS: geometry only** | Recreated as black opaque path | Geometry used | UI explains retained appearance, but SVG round-trip cannot retain it |
| group placeholder `x/y/width/height/rotation/fill/stroke` | Intentionally unused | Intentionally unused | Intentionally unused | Derived from children | Correctly not exposed as direct group paint |

## Verified findings

### F01 — `stroke.align` is a no-op in every visual consumer

- **Property / node type:** `Stroke.align`; rectangle, ellipse, path, and text.
- **Dropped by:** CanvasKit rendering, SVG export, hit-testing, and paint bounds. SVG import always reconstructs center alignment.
- **Severity:** **S1 — user-visible silent failure.** This is the worst Inspector UX class: three active buttons write a value that does not change canvas or exported SVG.
- **Evidence:**
  - Model defines `inside | center | outside`: `packages/core/src/types.ts:66-75`.
  - Inspector writes all three values for any leaf: `packages/editor/src/components/Inspector.tsx:782-805`.
  - Canvas stroke code sets only style and width; it never reads `align`: `packages/renderer/src/renderer.ts:1080-1108`.
  - SVG emits only `stroke` and `stroke-width`: `packages/editor/src/lib/export.ts:302-310`.
  - Paint bounds always assume a centered half-width outset: `packages/core/src/queries.ts:414-425`.
  - Import hardcodes `align: "center"`: `packages/editor/src/lib/svg-import.ts:453-459`.
- **Fix sketch:** Implement inside/outside geometry consistently (outline/offset path or doubled stroke plus clipping/masking), make hit/paint bounds alignment-aware, and either encode alignment in interoperable outlined SVG geometry or disable unsupported Inspector choices.

### F02 — exported `PathNode` strokes disappear on SVG re-import

- **Property / node type:** `stroke.color`, `stroke.paint`, and `stroke.width`; `PathNode`.
- **Dropped by:** SVG import round-trip.
- **Severity:** **S1 — user-visible silent failure.** A path can round-trip with its fill but no outline.
- **Evidence:**
  - Path export places fill/stroke on a transformed wrapper `<g>` and emits a bare child `<path>`: `packages/editor/src/lib/export.ts:376-389`.
  - Import inheritance carries only fill, fill rule, and opacity through groups: `packages/editor/src/lib/svg-import.ts:302-347`.
  - Import reads stroke and stroke width only from the current leaf element: `packages/editor/src/lib/svg-import.ts:365-369`, `packages/editor/src/lib/svg-import.ts:381-394`.
- **Fix sketch:** Add inherited stroke/stroke-width/paint-server state to `walk`, or put path stroke attributes on the exported child `<path>`.

### F03 — text-on-path hit-testing and selection do not follow the referenced path

- **Property / node type:** `TextNode.onPath.pathId`; attached text.
- **Dropped by:** Renderer hit-testing and selection bounds.
- **Severity:** **S1 — user-visible silent failure.** After the path moves/resizes/rotates, glyphs reflow at the new location but the clickable/selected text box can stay at the old location. A path already rotated at attach time also has a non-rotated text hit box.
- **Evidence:**
  - Attach copies only path `x/y/width/height`, once; it does not copy rotation or establish live bound derivation: `packages/editor/src/lib/text-on-path.ts:38-73`.
  - Canvas text-on-path rendering re-reads and transforms the live path, including its rotation, every draw: `packages/renderer/src/renderer.ts:1193-1236`.
  - Text hit-testing uses only the text node's own box and rotation, then returns a box hit: `packages/renderer/src/renderer.ts:407-425`, `packages/renderer/src/renderer.ts:462-463`.
  - Selection frames likewise use the text node box: `packages/core/src/queries.ts:564-596`.
- **Fix sketch:** Derive attached-text interaction bounds from the referenced path or cached glyph layout on every frame; use those derived bounds for hit-test, hover, selection, and gradients.

### F04 — SVG import drops all text and all text-specific properties

- **Property / node type:** Entire `TextNode`, including content, font family/size/weight/style, spacing, line height, align, kerning, OT features, stroke/gradient stroke, effects, blend mode, and `onPath`.
- **Dropped by:** SVG import round-trip.
- **Severity:** **S1 — user-visible silent failure.** Exported editable text returns as nothing, not as text or outlines.
- **Evidence:**
  - Import's own scope comment documents text as skipped: `packages/editor/src/lib/svg-import.ts:16-23`.
  - Walker returns immediately for every `<text>`: `packages/editor/src/lib/svg-import.ts:351-353`.
  - SVG export emits both ordinary `<text>` and `<textPath>`: `packages/editor/src/lib/export.ts:175-215`, `packages/editor/src/lib/export.ts:335-373`.
- **Fix sketch:** Parse the OpenLogo-emitted text subset into `TextNode`s, including referenced text paths and typography; if unsupported, surface an import warning/count instead of silently returning a partial import.

### F05 — text-on-path alignment is exposed but ignored by canvas and SVG

- **Property / node type:** `TextNode.align`; attached text.
- **Dropped by:** CanvasKit `drawTextOnPath` and SVG `textPath` export.
- **Severity:** **S1 — user-visible silent failure.** Left/center/right buttons remain active but produce no change.
- **Evidence:**
  - Inspector always renders alignment buttons: `packages/editor/src/components/Inspector.tsx:1198-1254`.
  - Renderer explicitly states `node.align` is ignored, and the implementation starts the pen only from `startOffset`: `packages/renderer/src/renderer.ts:1180-1184`, `packages/renderer/src/renderer.ts:1274-1282`.
  - SVG text-path markup emits `startOffset` but no `text-anchor` or align-derived offset: `packages/editor/src/lib/export.ts:208-214`.
- **Fix sketch:** Define alignment relative to available path length and map it to pen origin / SVG `text-anchor` plus percentage or computed `startOffset`; otherwise disable align controls while attached.

### F06 — text-on-path OT features are ignored by CanvasKit

- **Property / node type:** `TextNode.otFeatures`; attached text.
- **Dropped by:** CanvasKit `drawTextOnPath`.
- **Severity:** **S1 — user-visible silent failure.** Ligature, discretionary-ligature, and small-cap toggles remain editable, but path text uses unshaped per-character glyph IDs.
- **Evidence:**
  - Inspector exposes these toggles for every text node: `packages/editor/src/components/Inspector.tsx:1292-1379`.
  - Normal paragraphs map `otFeatures` into CanvasKit `fontFeatures`: `packages/renderer/src/renderer.ts:1390-1409`.
  - Path text instead calls `font.getGlyphIDs(node.content)` and lays glyphs one-by-one; `otFeatures` is never read in the function: `packages/renderer/src/renderer.ts:1253-1272`.
  - SVG export does retain `font-feature-settings`: `packages/editor/src/lib/export.ts:160-173`, `packages/editor/src/lib/export.ts:311-321`.
- **Fix sketch:** Shape text into positioned glyph runs with the selected OpenType features before arc placement, or disable unsupported feature controls for attached text.

### F07 — text-on-path line height and multiline content have no line layout

- **Property / node type:** `TextNode.lineHeight` and newline-bearing `content`; attached text.
- **Dropped by:** CanvasKit path text and SVG text-path structure.
- **Severity:** **S1 — user-visible silent failure.** Inspector permits multiline content and line-height changes, but attached text is implemented as one glyph stream / one `<textPath>`.
- **Evidence:**
  - Inspector exposes content and line height without an attached-text guard: `packages/editor/src/components/Inspector.tsx:1116-1127`, `packages/editor/src/components/Inspector.tsx:1213-1219`.
  - Canvas path text converts the complete content to one glyph array and never reads `lineHeight`: `packages/renderer/src/renderer.ts:1253-1282`.
  - SVG emits the full escaped content inside one `<textPath>` and creates no per-line tspans: `packages/editor/src/lib/export.ts:208-214`.
  - Ordinary SVG text does have explicit per-line tspans, showing the missing parallel handling: `packages/editor/src/lib/export.ts:356-373`.
- **Fix sketch:** Reject/normalize newlines while attached, or implement explicit multi-line path offsets in both consumers; disable line-height when only a single path line is supported.

### F08 — path/line stroke hit tolerance is clipped by the unstroked node box

- **Property / node type:** `stroke.width`; all `PathNode`s, especially parametric `line` nodes.
- **Dropped by:** Renderer hit-testing.
- **Severity:** **S1 — user-visible silent failure.** Visible outer half-strokes cannot be clicked. Horizontal/vertical line nodes have a near-zero box, so the later six-pixel tolerance is largely defeated.
- **Evidence:**
  - Hit-test rejects every point outside the axis-aligned un-stroked node box before path testing: `packages/renderer/src/renderer.ts:412-426`.
  - Only after that rejection does path code create a minimum-six-pixel stroked hit shape: `packages/renderer/src/renderer.ts:434-458`.
  - Vector line boxes clamp a zero dimension to only `0.01`: `packages/core/src/shapes.ts:198-216`; default line stroke is width `3`: `packages/core/src/shapes.ts:260-282`.
- **Fix sketch:** Expand the coarse rejection box by stroke/tolerance first, then test fill and stroked geometry; account for alignment and path scale.

### F09 — rectangle corner radius is ignored by hit-testing

- **Property / node type:** `RectangleNode.cornerRadius`.
- **Dropped by:** Renderer hit-testing.
- **Severity:** **S2 — interaction mismatch.** Transparent rounded-off corners still select the rectangle.
- **Evidence:**
  - Canvas draws an `RRect` with `cornerRadius`: `packages/renderer/src/renderer.ts:1047-1054`.
  - Hit-testing special-cases ellipse and path only; rectangles fall through to unconditional box success: `packages/renderer/src/renderer.ts:428-463`.
- **Fix sketch:** Use rounded-rectangle containment for rectangle fills and stroked rounded geometry for outline hits.

### F10 — text height is editable but has no text-layout or clipping effect

- **Property / node type:** Base `height`; `TextNode`.
- **Dropped by:** Canvas paragraph layout and SVG text layout.
- **Severity:** **S2 — cosmetic/UI mismatch.** Editing H changes selection/gradient bounds but neither reflows nor clips text.
- **Evidence:**
  - Inspector exposes H for every leaf: `packages/editor/src/components/Inspector.tsx:874-893`.
  - Paragraph cache/layout uses `node.width` but not `node.height`; layout is called with width only: `packages/renderer/src/renderer.ts:1352-1366`, `packages/renderer/src/renderer.ts:1454-1456`.
  - SVG text styling emits `inline-size:${node.width}px` but no height or clipping semantics: `packages/editor/src/lib/export.ts:311-317`.
- **Fix sketch:** Define height semantics (clip frame, vertical alignment, or auto-height), implement the same choice in canvas/SVG, or remove/disable H for text.

### F11 — text paint/hit/export bounds use the model box, not rendered paragraph extents

- **Property / node type:** Text `content`, `fontSize`, `lineHeight`, `letterSpacing`, kerning, and OT features when they make glyphs exceed `width/height`.
- **Dropped by:** Hit-testing, selection bounds, and paint-aware export bounds.
- **Severity:** **S2 — interaction/cropping mismatch.** Canvas draws the paragraph without clipping, but selection/hit/export view boxes can be smaller than the painted glyphs or effect bleed.
- **Evidence:**
  - Canvas draws the paragraph directly and exposes actual `getLongestLine()` / `getHeight()` metrics: `packages/renderer/src/renderer.ts:1120-1154`, `packages/renderer/src/renderer.ts:1462-1474`.
  - Hit-testing treats text as its stored box: `packages/renderer/src/renderer.ts:412-425`, `packages/renderer/src/renderer.ts:462-463`.
  - `nodeBounds` and `paintBounds` start from stored `x/y/width/height`, not paragraph metrics: `packages/core/src/queries.ts:259-264`, `packages/core/src/queries.ts:381-386`.
  - Selection SVG bounds use `paintBounds`: `packages/editor/src/lib/export.ts:506-544`.
- **Fix sketch:** Maintain authoritative text layout bounds in the model or a shared metrics service and use them for canvas interaction and export extents.

### F12 — group opacity has different compositing semantics in canvas and SVG

- **Property / node type:** `GroupNode.opacity`.
- **Dropped by:** SVG fidelity relative to the model/CanvasKit cascade semantics.
- **Severity:** **S1 — user-visible silent mismatch.** Overlapping children look different: canvas multiplies opacity into each child before overlap; SVG applies opacity once to the flattened group.
- **Evidence:**
  - Model explicitly says group opacity cascades down the subtree: `packages/core/src/types.ts:252-262`.
  - Renderer multiplies `node.opacity` into every child: `packages/renderer/src/renderer.ts:790-803`, then applies it to leaves: `packages/renderer/src/renderer.ts:837-842`.
  - SVG puts one `opacity` attribute on the outer group: `packages/editor/src/lib/export.ts:461-468`.
- **Fix sketch:** Export cascaded opacity on descendants to match the model, or deliberately redefine renderer/model semantics as isolated group opacity and implement a saveLayer.

### F13 — clipping-group effects are clipped in SVG but bleed outside the mask on canvas

- **Property / node type:** `effects[]`; clipping `GroupNode`.
- **Dropped by:** SVG export fidelity.
- **Severity:** **S1 — user-visible silent mismatch.** Canvas applies effects after clipping the child content, allowing shadow/glow/outline bleed outside the mask; SVG places filter and clip on the same group, so SVG's filter-then-clip order clips that bleed back to the mask.
- **Evidence:**
  - Renderer builds clipped child content inside the callback and applies group effects outside that callback: `packages/renderer/src/renderer.ts:790-833`.
  - Core paint bounds explicitly encode “child paint is clipped first, then group effects may bleed outside”: `packages/core/src/queries.ts:349-352`, `packages/core/src/queries.ts:398-407`.
  - Export attaches both `filter` and `clip-path` to the same `<g>`: `packages/editor/src/lib/export.ts:437-468`.
  - SVG 1.1 rendering order applies filters before clipping/masking/object opacity: https://www.w3.org/TR/SVG11/single-page.html#render-RenderingOrder
- **Fix sketch:** Emit nested groups: inner group owns `clip-path`; outer group owns the effect filter (plus the intended opacity/blend ordering).

### F14 — SVG effect filters use a fixed region that can clip valid effects

- **Property / node type:** Large drop-shadow offsets/blur, glow blur, and outline width; every node type including text and groups.
- **Dropped by:** SVG export.
- **Severity:** **S1 — user-visible silent failure.** Inspector/model impose no maximum, but export always allows only 60% bleed on each side.
- **Evidence:**
  - Every generated filter uses `x="-60%" y="-60%" width="220%" height="220%"`: `packages/editor/src/lib/export.ts:44-53`.
  - Inspector clamps these dimensions only at zero, not to a size-relative maximum: `packages/editor/src/components/Inspector.tsx:1580-1733`.
  - Core paint bounds already computes data-driven effect extents: `packages/core/src/queries.ts:438-461`.
- **Fix sketch:** Generate `filterUnits="userSpaceOnUse"` with bounds derived from node/subtree paint bounds, or calculate safe percentage extents per effect and object size.

### F15 — SVG import loses gradients, including gradient strokes

- **Property / node type:** Linear/radial fill and `stroke.paint`; all supported shapes; gradient stroke on text is also lost because text is skipped.
- **Dropped by:** SVG import round-trip.
- **Severity:** **S1 — user-visible silent failure.** Gradient fills become `#111827`; direct gradient strokes become an unresolved `url(#...)` string rather than a model `Paint`; path gradient strokes are lost entirely by F02.
- **Evidence:**
  - Import documentation declares gradients unsupported: `packages/editor/src/lib/svg-import.ts:16-23`.
  - Any URL fill is replaced with `#111827`: `packages/editor/src/lib/svg-import.ts:370-375`.
  - Stroke is captured only as a raw string color/width pair, with no paint-server resolution: `packages/editor/src/lib/svg-import.ts:365-392`.
  - Built nodes always use solid fill and non-painted stroke objects: `packages/editor/src/lib/svg-import.ts:437-460`.
- **Fix sketch:** Resolve OpenLogo-emitted linear/radial gradient definitions and reconstruct normalized geometry, stops, alpha, focal points, and `stroke.paint`.

### F16 — SVG import drops blend modes and all effects

- **Property / node type:** `blendMode` and every `effects[]` type; leaves, text, and groups.
- **Dropped by:** SVG import round-trip.
- **Severity:** **S1 — user-visible silent failure.** Imported artwork silently loses compositing, shadows, outlines, bevels, and glows.
- **Evidence:**
  - Export emits `mix-blend-mode` and filter references for leaves: `packages/editor/src/lib/export.ts:311-323`; groups: `packages/editor/src/lib/export.ts:461-468`.
  - Import state carries only fill/fillRule/opacity/stroke/geometry: `packages/editor/src/lib/svg-import.ts:194-220`.
  - Constructed nodes never assign `blendMode` or `effects`: `packages/editor/src/lib/svg-import.ts:437-466`.
- **Fix sketch:** Parse the exact filter graph subset emitted by `effectsAttr` plus `mix-blend-mode`; warn when an external filter graph cannot map to the model.

### F17 — zero opacity and fully transparent shapes do not round-trip

- **Property / node type:** `opacity = 0` and transparent solid fill; supported SVG shapes/groups.
- **Dropped by:** SVG import.
- **Severity:** **S1 — user-visible silent failure.** An opacity-zero node becomes 1% opaque; a transparent-fill/no-stroke node disappears entirely.
- **Evidence:**
  - Import multiplies inherited opacity and correctly permits zero during walking: `packages/editor/src/lib/svg-import.ts:327-330`.
  - Node construction then clamps opacity to a minimum of `0.01`: `packages/editor/src/lib/svg-import.ts:445-448`.
  - Transparent fill with no stroke is discarded: `packages/editor/src/lib/svg-import.ts:370-379`.
  - Core model legitimately permits opacity zero: `packages/core/src/types.ts:127-149`; schema range includes zero: `packages/core/src/schema.ts:95-113`.
- **Fix sketch:** Preserve `0..1` exactly. Retain transparent nodes when importing OpenLogo SVGs, or report deliberate pruning to the user.

### F18 — hidden children still affect group selection and export bounds

- **Property / node type:** `visible`; hidden nodes inside groups, and hidden nodes passed to paint-bound consumers.
- **Dropped by:** Core visual/paint bounds used by renderer selection and SVG selection exports.
- **Severity:** **S2 — interaction/layout mismatch.** A hidden far-away child can enlarge a group's handles and selection-export viewBox even though renderer/export body omits it.
- **Evidence:**
  - Renderer and SVG tree correctly skip invisible nodes: `packages/renderer/src/renderer.ts:785-787`; `packages/editor/src/lib/export.ts:431-435`.
  - `visualBounds` unions every non-mask child without checking `visible`: `packages/core/src/queries.ts:305-345`.
  - `paintBounds` does the same and also computes bounds for invisible leaves: `packages/core/src/queries.ts:361-410`.
  - Group hover/selection uses `unitBounds`/`selectionFrame`: `packages/renderer/src/renderer.ts:1655-1660`, `packages/renderer/src/renderer.ts:1700-1705`.
- **Fix sketch:** Exclude invisible descendants from visual and paint unions (while retaining mask geometry when required by clipping semantics).

### F19 — stroke-gradient geometry cannot be fully edited despite shared Inspector messaging

- **Property / node type:** Linear stroke `start/end`; radial stroke `cx/cy/r/fx/fy`; any stroked leaf.
- **Dropped by:** Inspector/on-canvas gradient editing.
- **Severity:** **S2 — UI capability mismatch.** The shared stroke PaintEditor says “Press G to edit on canvas,” but the G annotator reads and edits only `node.fill`. Stroke stops/type/angle can be edited; explicit endpoints, radial center/radius, and focal position cannot be manipulated on canvas.
- **Evidence:**
  - Stroke uses the shared PaintEditor: `packages/editor/src/components/Inspector.tsx:808-821`.
  - Shared PaintEditor displays G-tool guidance for linear and radial paint: `packages/editor/src/components/PaintEditor.tsx:503-542`.
  - Gradient annotator checks only `node.fill` and branches exclusively on `node.fill.type`: `packages/editor/src/canvas/GradientAnnotator.tsx:27-42`, `packages/editor/src/canvas/GradientAnnotator.tsx:73-116`.
- **Fix sketch:** Add a fill/stroke target to gradient tool state and route annotator reads/writes to `stroke.paint` when invoked from Stroke, or remove the misleading G affordance and expose numeric geometry controls.

### F20 — SVG round-trip loses editing structure and clipping-mask appearance

- **Property / node type:** Ordinary group hierarchy, rectangle/ellipse type, `cornerRadius`, parametric path `shape`, node names, explicit rotation fields, and stored appearance of a clipping-mask child.
- **Dropped by:** SVG import/export round-trip.
- **Severity:** **S3 for flattened primitive metadata; S2 for groups and mask release appearance.** Most visible geometry survives, but editability and group behavior do not. Releasing a re-imported clipping mask reveals a black opaque path instead of the original stored mask styling.
- **Evidence:**
  - Import intentionally flattens every supported shape and transform to `PathNode`: `packages/editor/src/lib/svg-import.ts:16-20`, `packages/editor/src/lib/svg-import.ts:415-466`.
  - Ordinary `<g>` elements are traversed and flattened; only clipping groups are reconstructed: `packages/editor/src/lib/svg-import.ts:332-349`, `packages/editor/src/lib/svg-import.ts:607-670`.
  - Export's clip geometry deliberately omits paint, stroke, opacity, and effects: `packages/editor/src/lib/export.ts:392-424`.
  - Import recreates the clipping mask with black fill, opacity 1, and no stroke: `packages/editor/src/lib/svg-import.ts:284-297`.
- **Fix sketch:** Add OpenLogo namespace/data attributes for lossless editor round-trip, or provide a documented “visual import” mode with a clear loss summary. Preserve mask appearance in metadata outside `<clipPath>` if release fidelity is required.

## Lower-risk completeness notes

These are verified but not ranked as additional user-visible findings:

- Linear `start/end` and radial `fx/fy` are independently optional in schema (`packages/core/src/schema.ts:30-47`), but both canvas/export consume them only as complete pairs (`packages/core/src/gradient.ts:32-47`, `packages/core/src/gradient.ts:60-76`, `packages/editor/src/lib/export.ts:239-256`). Current UI writes pairs, so this is mainly a malformed/external-document invariant risk. Enforce paired optionals in schema or normalize partial pairs.
- The Inspector exposes only fixed OT feature groups (`liga`, `clig`, `dlig`, `smcp`) although the model accepts any valid four-character tag (`packages/editor/src/components/Inspector.tsx:1322-1357`, `packages/core/src/types.ts:243-247`). Existing arbitrary tags survive model/export but cannot be individually edited in Inspector.
- D-only flipped text paths export via SVG2 `side="right"`, which the exporter itself notes some renderers ignore (`packages/editor/src/lib/export.ts:135-140`, `packages/editor/src/lib/export.ts:185-193`). Structured path geometry avoids this by emitting a reversed path.
- Selection handles intentionally describe geometry rather than effect bleed (`packages/core/src/queries.ts:293-296`, `packages/core/src/queries.ts:551-596`). Effect shadows/glows not being directly clickable is treated as benign editor behavior, not a defect.
- Hidden nodes are intentionally omitted from visual SVG export, and `locked` is editor-only metadata. Their absence from plain SVG is not itself counted as a visual defect; it is part of the structural round-trip loss in F20.

## Explicit checks that did not reveal a gap

- **Effects on text:** Canvas effects wrap every leaf through `drawWithEffects`, including `drawText`; SVG calls `effectsAttr` before emitting text (`packages/renderer/src/renderer.ts:879-890`, `packages/editor/src/lib/export.ts:322-340`). The known missing canvas text stroke can change the source silhouette, but that known defect is excluded.
- **Effects on ordinary groups:** Canvas applies all four effect types to the subtree and SVG emits the same effect filter family (`packages/renderer/src/renderer.ts:790-833`, `packages/editor/src/lib/export.ts:44-132`). Clipping-group ordering remains F13.
- **Blend mode on text-on-path:** Canvas wraps the entire leaf before `drawTextOnPath`; SVG includes blend style in `base` passed to `textOnPathMarkup` (`packages/renderer/src/renderer.ts:879-890`, `packages/editor/src/lib/export.ts:311-340`). Import still loses the text entirely.
- **Gradient fill on all three text paths:** Normal paragraph gradient masking, solid paragraph fill, and text-on-path `makePaint` are implemented (`packages/renderer/src/renderer.ts:1112-1154`, `packages/renderer/src/renderer.ts:1312-1323`). Attached-text gradient anchoring becomes stale with the text box/path mismatch described in F03.
- **Path fill rule:** Canvas path construction sets EvenOdd/Winding, SVG emits `fill-rule`, clipping emits `clip-rule`, and import reads it (`packages/renderer/src/renderer.ts:1552-1567`, `packages/editor/src/lib/export.ts:387-389`, `packages/editor/src/lib/export.ts:421-423`, `packages/editor/src/lib/svg-import.ts:318-326`).
- **Group lock cascade:** `getRenderNodesForArtboard` folds ancestor lock into cloned leaves before renderer hit-testing (`packages/core/src/queries.ts:487-535`, `packages/renderer/src/renderer.ts:372-383`).

## Ranked top five

1. **F01 — `stroke.align` is a global no-op.** Broadest live Inspector lie: every leaf type, canvas, SVG, hit-testing, and bounds.
2. **F02 — exported path strokes vanish on re-import.** Common visible artwork loss caused by a precise wrapper/inheritance mismatch.
3. **F03 — text-on-path interaction bounds do not follow the path.** Rendering and selection can occupy different locations after ordinary path edits.
4. **F04 — SVG import silently drops all text.** Total loss of an entire node type and every property on it.
5. **F05/F06/F07 — attached-text controls exceed renderer capability.** Alignment, multiline/line-height, and OT features remain editable while path rendering ignores them; alignment/multiline also lack faithful SVG structure.

