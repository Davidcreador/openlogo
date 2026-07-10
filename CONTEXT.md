# OpenLogo Editing Context

OpenLogo models a local-first logo workspace whose editable file can contain several production variants. This glossary keeps product, model, renderer, and persistence language aligned.

## Language

**Logo Document**:
An editable OpenLogo file containing artboards, logo nodes, color palettes, and the active artboard.
_Avoid_: Project, canvas, browser document

**Document Session**:
The editing lifetime that hydrates one Logo Document, persists its committed changes in order, and reports recovery or save failures.
_Avoid_: Autosave hook, IndexedDB session

**Document Library**:
The local collection of Logo Documents, their current heads, metadata, and retained versions.
_Avoid_: Project list, recent files

**Document Head**:
The newest authoritative revision of one Logo Document in the Document Library.
_Avoid_: Current file, latest version

**Document Version**:
An immutable snapshot retained outside the Document Head. Versions may be automatic recovery checkpoints, user-named milestones, migration snapshots, or conflict copies.
_Avoid_: Undo state, schema version

**Active Library Document**:
The Logo Document whose head is currently adopted by the Document Session.
_Avoid_: Open project, selected file

**Archived Library Document**:
A retained Logo Document excluded from normal switching and new commits until it is explicitly restored.
_Avoid_: Deleted document, trash item

**Artboard**:
A named and positioned output region with a purpose, background, guides, and ordered top-level logo nodes.
_Avoid_: Page, frame, canvas

**Active Artboard**:
The Artboard that receives newly created logo nodes and is used by default for previews and exports.
_Avoid_: Selected page, current canvas

**Logo Node**:
An editable scene item represented by a rectangle, ellipse, path, text object, or group.
_Avoid_: Element, layer, shape when the specific node type is known

**Selection Unit**:
A Logo Node or group treated as one target for selection, transforms, and operations.
_Avoid_: Leaf, selected element

**Active Group**:
The group whose direct children form the current isolation scope for selection.
_Avoid_: Open layer, selected group

**Path Node**:
A Logo Node whose rendered outline is represented by SVG path data and may also carry editable Path Geometry.
_Avoid_: Vector when the path representation matters

**Path Geometry**:
The canonical subpaths, anchors, and Bezier handles required for direct node editing.
_Avoid_: SVG path data, `d`

**Compound Path**:
A single Path Node containing multiple subpaths whose combined interior is interpreted by its Fill Rule.
_Avoid_: Group, flattened boolean result

**Fill Rule**:
The explicit `nonzero` or `evenodd` rule that determines which regions of a Path Node are filled and hit-testable.
_Avoid_: Hole mode, winding toggle

**Clipping Group**:
A group Logo Node that explicitly owns one direct child as its Clipping Path and renders every other child through that filled geometry.
_Avoid_: Mask tag, clipped layer collection

**Clipping Path**:
The rectangle, ellipse, or Path Node directly owned by a Clipping Group as its clipping geometry. Its appearance remains editable but does not paint until release.
_Avoid_: Mask object, crop shape

**Preview Change**:
A transient gesture state rendered live but excluded from history and persistence.
_Avoid_: Draft save, temporary command

**Committed Change**:
A completed document mutation eligible for undo history and persistence.
_Avoid_: Preview, frame update

## Relationships

- A **Document Session** owns exactly one live **Logo Document**.
- A **Document Library** contains one or more **Document Heads** and identifies exactly one **Active Library Document**.
- The **Active Library Document** is always unarchived.
- A **Document Head** advances by optimistic revision; a stale write becomes a recovery **Document Version** instead of overwriting it.
- Switching the **Active Library Document** flushes the current **Document Session** first and aborts if that save cannot finish.
- Archiving the **Active Library Document** atomically adopts another unarchived head; the last unarchived document cannot be archived.
- An **Archived Library Document** retains its head and versions but rejects activation and commits until restored; restoring it does not open it.
- Restoring a **Document Version** creates a new **Document Head** revision; restoring an **Archived Library Document** only clears archive state.
- A **Logo Document** contains one or more **Artboards** and has exactly one **Active Artboard**.
- An **Artboard** owns zero or more top-level **Logo Nodes** in back-to-front order.
- A group **Logo Node** owns child **Logo Nodes** and may become the **Active Group**.
- A **Selection Unit** resolves to one or more drawable leaf **Logo Nodes**.
- A **Path Node** uses SVG path data for rendering and **Path Geometry** for direct anchor editing.
- A **Compound Path** remains one Path Node; releasing it emits independent sibling Path Nodes.
- A **Clipping Group** owns exactly one direct **Clipping Path** and zero or more content Logo Nodes; ownership never depends on layer order or per-node tags.
- Releasing a **Clipping Group** preserves its **Clipping Path** and content as sibling Logo Nodes.
- A gesture may emit many **Preview Changes** before producing one **Committed Change**.

## Example dialogue

> **Designer:** "I moved the horizontal lockup while the file was still restoring. Will the older copy replace it?"
> **Developer:** "No. The **Document Session** never replaces a newer **Committed Change** with a late restore, and **Preview Changes** are never autosaved."

## Flagged ambiguities

- "document" can mean the **Logo Document** or the browser DOM document; product and model discussions use **Logo Document**, while browser code says "DOM document" explicitly.
- "version" can mean a **Document Version**, the optimistic head revision, or `schemaVersion`; use the precise term.
- "project" is common design-tool language, but one OpenLogo **Logo Document** already contains a complete variant system. Use **Document Library** until a higher-level client/project aggregate is actually modeled.
- "path" can mean a **Path Node**, SVG path data, or **Path Geometry**; use the precise term because only Path Geometry guarantees anchor editing.
- "mask" can mean a **Clipping Group**, its **Clipping Path**, or an SVG alpha mask; OpenLogo currently models the first two and does not treat SVG alpha masks as clipping paths.
