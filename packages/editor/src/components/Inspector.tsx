import { useEffect, useRef, useState } from "react";
import {
  AlignCenter,
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceBetween,
  AlignLeft,
  AlignRight,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceBetween,
  ChevronDown,
  ChevronRight,
  Circle,
  Eye,
  EyeOff,
  FlipHorizontal2,
  FlipVertical2,
  Folder,
  Lock,
  PenTool,
  RotateCw,
  Sparkles,
  Square,
  Type,
  Unlock,
} from "lucide-react";
import {
  type GroupNode,
  type LogoDocument,
  type LogoNode,
  type NodePatch,
  analyzeLogoDocument,
  collectLeafNodeIds,
  getContainerChildIds,
  unitBounds,
} from "@openlogo/core";
import {
  FONT_CATALOG,
  catalogEntry,
  fontStore,
  nearestWeight,
} from "../lib/font-store";
import {
  moveUnitToContainer,
  rotateUnitBy,
  setUnitBounds,
  ungroupSelection,
} from "../lib/group-ops";
import {
  alignNodes,
  distributeNodes,
  expandStrokeOp,
  flipNodes,
  rotateCopies,
} from "../lib/object-ops";
import { editSwatch } from "../lib/swatches";
import { convertTextToPath } from "../lib/text-to-path";
import { documentStore, useDocument } from "../state/document";
import { useEditorStore } from "../state/editor-store";

const WEIGHT_LABELS: Record<number, string> = {
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold",
  800: "Extra bold",
  900: "Black",
};

const NODE_ICONS = {
  rectangle: Square,
  ellipse: Circle,
  path: PenTool,
  text: Type,
  group: Folder,
} as const;

/** Numeric field that commits on blur/Enter and follows external changes. */
function NumberField({
  label,
  value,
  onCommit,
  step = 1,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  step?: number;
}) {
  const [draft, setDraft] = useState(String(Math.round(value * 100) / 100));

  useEffect(() => {
    setDraft(String(Math.round(value * 100) / 100));
  }, [value]);

  function commit() {
    const parsed = Number(draft);
    if (Number.isFinite(parsed) && parsed !== value) {
      onCommit(parsed);
    } else {
      setDraft(String(Math.round(value * 100) / 100));
    }
  }

  return (
    <label className="number-field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}

function AlignPanel({ nodeIds }: { nodeIds: readonly string[] }) {
  const canDistribute = nodeIds.length >= 3;

  const alignButtons = [
    { edge: "left", icon: AlignStartVertical, label: "Align left" },
    { edge: "centerX", icon: AlignCenterVertical, label: "Align center" },
    { edge: "right", icon: AlignEndVertical, label: "Align right" },
    { edge: "top", icon: AlignStartHorizontal, label: "Align top" },
    { edge: "centerY", icon: AlignCenterHorizontal, label: "Align middle" },
    { edge: "bottom", icon: AlignEndHorizontal, label: "Align bottom" },
  ] as const;

  return (
    <div className="align-panel" role="group" aria-label="Align and distribute">
      {alignButtons.map(({ edge, icon: Icon, label }) => (
        <button
          key={edge}
          type="button"
          title={label}
          aria-label={label}
          onClick={() => alignNodes(nodeIds, edge)}
        >
          <Icon size={14} />
        </button>
      ))}
      <button
        type="button"
        title="Distribute horizontally"
        aria-label="Distribute horizontally"
        disabled={!canDistribute}
        onClick={() => distributeNodes(nodeIds, "horizontal")}
      >
        <AlignHorizontalSpaceBetween size={14} />
      </button>
      <button
        type="button"
        title="Distribute vertically"
        aria-label="Distribute vertically"
        disabled={!canDistribute}
        onClick={() => distributeNodes(nodeIds, "vertical")}
      >
        <AlignVerticalSpaceBetween size={14} />
      </button>
      <button
        type="button"
        title="Flip horizontal"
        aria-label="Flip horizontal"
        onClick={() => flipNodes(nodeIds, "horizontal")}
      >
        <FlipHorizontal2 size={14} />
      </button>
      <button
        type="button"
        title="Flip vertical"
        aria-label="Flip vertical"
        onClick={() => flipNodes(nodeIds, "vertical")}
      >
        <FlipVertical2 size={14} />
      </button>
    </div>
  );
}

function FillEditor({
  node,
  patchSelection,
}: {
  node: LogoNode;
  patchSelection: (patch: NodePatch) => void;
}) {
  const isGradient = node.fill.type === "linear-gradient";
  const solidColor = node.fill.type === "solid" ? node.fill.color : "#000000";

  return (
    <>
      <div className="fill-type-toggle" role="group" aria-label="Fill type">
        <button
          type="button"
          className={isGradient ? "" : "active"}
          onClick={() => {
            if (isGradient) {
              patchSelection({
                fill: {
                  type: "solid",
                  color:
                    node.fill.type === "linear-gradient"
                      ? (node.fill.stops[0]?.color ?? "#111827")
                      : "#111827",
                },
              });
            }
          }}
        >
          Solid
        </button>
        <button
          type="button"
          className={isGradient ? "active" : ""}
          onClick={() => {
            if (!isGradient) {
              patchSelection({
                fill: {
                  type: "linear-gradient",
                  angle: 90,
                  stops: [
                    { offset: 0, color: solidColor },
                    { offset: 1, color: "#4f6bf6" },
                  ],
                },
              });
            }
          }}
        >
          Gradient
        </button>
      </div>

      {node.fill.type === "linear-gradient" ? (
        <div className="gradient-editor">
          <div
            className="gradient-bar"
            style={{
              background: `linear-gradient(90deg, ${node.fill.stops
                .map((stop) => `${stop.color} ${stop.offset * 100}%`)
                .join(", ")})`,
            }}
          />
          <div className="fill-row">
            {node.fill.stops.map((stop, index) => (
              <input
                key={index}
                type="color"
                className="fill-swatch"
                value={stop.color}
                aria-label={`Gradient stop ${index + 1}`}
                onChange={(event) => {
                  if (node.fill.type !== "linear-gradient") {
                    return;
                  }
                  const stops = node.fill.stops.map((item, i) =>
                    i === index ? { ...item, color: event.target.value } : item,
                  );
                  patchSelection({ fill: { ...node.fill, stops } });
                }}
              />
            ))}
            <NumberField
              label="∠"
              value={node.fill.angle}
              onCommit={(angle) => {
                if (node.fill.type === "linear-gradient") {
                  patchSelection({ fill: { ...node.fill, angle } });
                }
              }}
            />
          </div>
        </div>
      ) : (
        <div className="fill-row">
          <input
            type="color"
            className="fill-swatch"
            value={solidColor}
            onChange={(event) =>
              patchSelection({
                fill: { type: "solid", color: event.target.value },
              })
            }
            aria-label="Fill color"
          />
          <input
            className="fill-hex"
            value={solidColor.toUpperCase()}
            onChange={(event) => {
              const value = event.target.value.trim();
              if (/^#[0-9a-fA-F]{6}$/.test(value)) {
                patchSelection({ fill: { type: "solid", color: value } });
              }
            }}
            aria-label="Fill hex"
          />
          <div className="opacity-field">
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={node.opacity}
              onChange={(event) =>
                patchSelection({ opacity: Number(event.target.value) })
              }
              aria-label="Opacity"
            />
            <span>{Math.round(node.opacity * 100)}%</span>
          </div>
        </div>
      )}
    </>
  );
}

function StrokeEditor({
  node,
  patchSelection,
}: {
  node: LogoNode;
  patchSelection: (patch: NodePatch) => void;
}) {
  const stroke = node.stroke;

  return (
    <div className="stroke-block">
      <div className="stroke-head">
        <span>Stroke</span>
        <button
          type="button"
          className="stroke-toggle"
          onClick={() =>
            patchSelection({
              stroke: stroke
                ? undefined
                : { color: "#111827", width: 2, align: "center" },
            })
          }
        >
          {stroke ? "Remove" : "Add"}
        </button>
      </div>
      {stroke && (
        <div className="fill-row">
          <input
            type="color"
            className="fill-swatch"
            value={stroke.color}
            aria-label="Stroke color"
            onChange={(event) =>
              patchSelection({
                stroke: { ...stroke, color: event.target.value },
              })
            }
          />
          <NumberField
            label="W"
            value={stroke.width}
            step={0.5}
            onCommit={(width) =>
              patchSelection({ stroke: { ...stroke, width: Math.max(0, width) } })
            }
          />
          {node.type !== "text" && (
            <button
              type="button"
              className="stroke-toggle"
              title="Outline stroke into a filled path"
              onClick={() => void expandStrokeOp(node.id)}
            >
              Expand
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DesignSection({
  node,
  patchSelection,
}: {
  node: LogoNode;
  patchSelection: (patch: NodePatch) => void;
}) {
  const document = useDocument();
  const setSelection = useEditorStore((state) => state.setSelection);
  const [copiesCount, setCopiesCount] = useState(6);

  return (
    <section className="inspector-section">
      <h2>Design</h2>

      <AlignPanel nodeIds={[node.id]} />

      <div className="field-grid">
        <NumberField label="X" value={node.x} onCommit={(x) => patchSelection({ x })} />
        <NumberField label="Y" value={node.y} onCommit={(y) => patchSelection({ y })} />
        <NumberField
          label="W"
          value={node.width}
          onCommit={(width) => patchSelection({ width: Math.max(1, width) })}
        />
        <NumberField
          label="H"
          value={node.height}
          onCommit={(height) => patchSelection({ height: Math.max(1, height) })}
        />
        <NumberField
          label="∠"
          value={node.rotation}
          onCommit={(rotation) => patchSelection({ rotation })}
        />
        {node.type === "rectangle" && (
          <NumberField
            label="◜"
            value={node.cornerRadius}
            onCommit={(cornerRadius) =>
              patchSelection({ cornerRadius: Math.max(0, cornerRadius) })
            }
          />
        )}
      </div>

      <FillEditor node={node} patchSelection={patchSelection} />
      <StrokeEditor node={node} patchSelection={patchSelection} />

      <div className="field-row" style={{ marginBottom: 10 }}>
        <select
          className="font-select"
          value={node.blendMode ?? "normal"}
          aria-label="Blend mode"
          onChange={(event) =>
            patchSelection({
              blendMode:
                event.target.value === "normal"
                  ? undefined
                  : (event.target.value as LogoNode["blendMode"]),
            })
          }
        >
          <option value="normal">Normal</option>
          <option value="multiply">Multiply</option>
          <option value="screen">Screen</option>
          <option value="overlay">Overlay</option>
          <option value="darken">Darken</option>
          <option value="lighten">Lighten</option>
        </select>
      </div>

      <div className="rotate-copies">
        <NumberField
          label="×"
          value={copiesCount}
          onCommit={(value) =>
            setCopiesCount(Math.max(2, Math.min(64, Math.round(value))))
          }
        />
        <button
          type="button"
          className="stroke-toggle"
          title="Repeat rotated copies around the artboard centre"
          onClick={() => {
            const ids = rotateCopies(node.id, copiesCount);
            if (ids.length > 0) {
              setSelection([node.id, ...ids]);
            }
          }}
        >
          <RotateCw size={12} /> Rotate copies
        </button>
      </div>

      <div className="swatch-row">
        {document.palettes[0]?.colors.map((color) => (
          <button
            key={color}
            type="button"
            className="swatch"
            style={{ background: color }}
            aria-label={`Use ${color}`}
            onClick={() => patchSelection({ fill: { type: "solid", color } })}
          />
        ))}
      </div>

      {node.type === "text" && (
        <div className="type-block">
          <label className="text-field">
            <span>Text</span>
            <input
              value={node.content}
              onChange={(event) =>
                patchSelection({ content: event.target.value })
              }
            />
          </label>

          <div className="field-row">
            <select
              className="font-select"
              value={catalogEntry(node.fontFamily)?.name ?? "Inter"}
              onChange={(event) => {
                const family = FONT_CATALOG.find(
                  (item) => item.name === event.target.value,
                );
                if (!family) {
                  return;
                }
                const weight = nearestWeight(family, node.fontWeight);
                void fontStore.ensure(family.name, weight);
                patchSelection({ fontFamily: family.name, fontWeight: weight });
              }}
              aria-label="Font family"
            >
              {FONT_CATALOG.map((family) => (
                <option key={family.id} value={family.name}>
                  {family.name}
                </option>
              ))}
            </select>
            <select
              className="weight-select"
              value={node.fontWeight}
              onChange={(event) => {
                const weight = Number(event.target.value);
                void fontStore.ensure(node.fontFamily, weight);
                patchSelection({ fontWeight: weight });
              }}
              aria-label="Font weight"
            >
              {(catalogEntry(node.fontFamily)?.weights ?? [400, 700]).map(
                (weight) => (
                  <option key={weight} value={weight}>
                    {WEIGHT_LABELS[weight] ?? weight}
                  </option>
                ),
              )}
            </select>
          </div>

          <div className="field-grid">
            <NumberField
              label="Size"
              value={node.fontSize}
              onCommit={(fontSize) =>
                patchSelection({ fontSize: Math.max(1, fontSize) })
              }
            />
            <NumberField
              label="Track"
              value={node.letterSpacing}
              step={0.1}
              onCommit={(letterSpacing) => patchSelection({ letterSpacing })}
            />
            <NumberField
              label="Line"
              value={node.lineHeight}
              step={0.05}
              onCommit={(lineHeight) =>
                patchSelection({ lineHeight: Math.max(0.5, lineHeight) })
              }
            />
            <div className="align-group" role="group" aria-label="Text align">
              {(
                [
                  ["left", AlignLeft],
                  ["center", AlignCenter],
                  ["right", AlignRight],
                ] as const
              ).map(([align, Icon]) => (
                <button
                  key={align}
                  type="button"
                  className={node.align === align ? "active" : ""}
                  onClick={() => patchSelection({ align })}
                  title={`Align ${align}`}
                  aria-label={`Align ${align}`}
                >
                  <Icon size={14} />
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            className="outline-button"
            disabled={node.content.length === 0}
            onClick={() => {
              void convertTextToPath(node.id).then((newId) => {
                if (newId) {
                  setSelection([newId]);
                }
              });
            }}
          >
            Convert to outlines
          </button>
        </div>
      )}
    </section>
  );
}

function GroupSection({ group }: { group: GroupNode }) {
  const document = useDocument();
  const setSelection = useEditorStore((state) => state.setSelection);
  // Remount key so the rotate-by field snaps back to 0 after committing.
  const [rotateNonce, setRotateNonce] = useState(0);
  const bounds = unitBounds(document, group.id);
  const leafCount = collectLeafNodeIds(document, [group.id]).length;

  if (!bounds) {
    return null;
  }

  return (
    <section className="inspector-section">
      <h2>Group</h2>
      <p className="muted" style={{ marginBottom: 10 }}>
        {group.name} — {leafCount} object{leafCount === 1 ? "" : "s"}
      </p>

      <AlignPanel nodeIds={[group.id]} />

      <div className="field-grid">
        <NumberField
          label="X"
          value={bounds.x}
          onCommit={(x) => setUnitBounds(group.id, { x })}
        />
        <NumberField
          label="Y"
          value={bounds.y}
          onCommit={(y) => setUnitBounds(group.id, { y })}
        />
        <NumberField
          label="W"
          value={bounds.width}
          onCommit={(width) =>
            setUnitBounds(group.id, { width: Math.max(1, width) })
          }
        />
        <NumberField
          label="H"
          value={bounds.height}
          onCommit={(height) =>
            setUnitBounds(group.id, { height: Math.max(1, height) })
          }
        />
        <NumberField
          key={rotateNonce}
          label="∠+"
          value={0}
          onCommit={(degrees) => {
            rotateUnitBy(group.id, degrees);
            setRotateNonce((nonce) => nonce + 1);
          }}
        />
      </div>

      <div className="fill-row">
        <div className="opacity-field">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={group.opacity}
            onChange={(event) =>
              documentStore.apply({
                type: "update-nodes",
                updates: [
                  {
                    nodeId: group.id,
                    patch: { opacity: Number(event.target.value) },
                  },
                ],
              })
            }
            aria-label="Group opacity"
          />
          <span>{Math.round(group.opacity * 100)}%</span>
        </div>
      </div>

      {/* Blend mode lives on the group itself: the renderer composites
          the whole subtree as one layer, not per child. */}
      <div className="field-row" style={{ marginBottom: 10 }}>
        <select
          className="font-select"
          value={group.blendMode ?? "normal"}
          aria-label="Blend mode"
          onChange={(event) =>
            documentStore.apply({
              type: "update-nodes",
              updates: [
                {
                  nodeId: group.id,
                  patch: {
                    blendMode:
                      event.target.value === "normal"
                        ? undefined
                        : (event.target.value as LogoNode["blendMode"]),
                  },
                },
              ],
            })
          }
        >
          <option value="normal">Normal</option>
          <option value="multiply">Multiply</option>
          <option value="screen">Screen</option>
          <option value="overlay">Overlay</option>
          <option value="darken">Darken</option>
          <option value="lighten">Lighten</option>
        </select>
      </div>

      <button
        type="button"
        className="outline-button"
        onClick={() => {
          const freed = ungroupSelection([group.id]);
          if (freed.length > 0) {
            setSelection(freed);
          }
        }}
      >
        Ungroup (⇧⌘G)
      </button>
    </section>
  );
}

function SwatchesSection() {
  const document = useDocument();
  const palette = document.palettes[0];
  if (!palette) {
    return null;
  }

  return (
    <section className="inspector-section">
      <h2>Brand colors</h2>
      <div className="swatch-row">
        {palette.colors.map((color, index) => (
          <input
            key={`${index}-${color}`}
            type="color"
            className="swatch swatch-editable"
            defaultValue={color}
            aria-label={`Edit brand color ${index + 1}`}
            title="Edit — recolors every use"
            onBlur={(event) => {
              if (event.target.value !== color) {
                editSwatch(palette.id, index, event.target.value);
              }
            }}
          />
        ))}
      </div>
      <p className="muted" style={{ marginTop: 8 }}>
        Editing a swatch recolors every object using it.
      </p>
    </section>
  );
}

type LayerRow = {
  node: LogoNode;
  depth: number;
  /** Artboard id (top level) or parent group id. */
  containerId: string;
  /** z-index within the container's ordering (back-to-front). */
  zIndex: number;
};

/** Flattened tree rows, topmost-first, honoring expanded groups. */
function buildLayerRows(
  document: LogoDocument,
  containerId: string,
  childIds: readonly string[],
  depth: number,
  expanded: ReadonlySet<string>,
): LayerRow[] {
  const rows: LayerRow[] = [];
  for (let zIndex = childIds.length - 1; zIndex >= 0; zIndex -= 1) {
    const node = document.nodes[childIds[zIndex]!];
    if (!node) {
      continue;
    }
    rows.push({ node, depth, containerId, zIndex });
    if (node.type === "group" && expanded.has(node.id)) {
      rows.push(
        ...buildLayerRows(document, node.id, node.children, depth + 1, expanded),
      );
    }
  }
  return rows;
}

function LayersSection() {
  const document = useDocument();
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const setSelection = useEditorStore((state) => state.setSelection);
  const setActiveGroupId = useEditorStore((state) => state.setActiveGroupId);
  // Ref, not state: drop can fire before a state commit lands.
  const dragRef = useRef<LayerRow | null>(null);
  const [dropRow, setDropRow] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const artboard = document.artboards.find(
    (item) => item.id === document.activeArtboardId,
  );
  const rows = artboard
    ? buildLayerRows(document, artboard.id, artboard.nodeIds, 0, expanded)
    : [];

  function toggle(nodeId: string, patch: NodePatch) {
    documentStore.apply({ type: "update-nodes", updates: [{ nodeId, patch }] });
  }

  function toggleExpanded(groupId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }

  function handleDrop(target: LayerRow) {
    const dragged = dragRef.current;
    dragRef.current = null;
    setDropRow(null);
    if (!dragged || dragged.node.id === target.node.id) {
      return;
    }

    // Dropping onto a group row nests into it, topmost in its stack;
    // onto the group that already holds it, reorders to the top instead.
    if (target.node.type === "group") {
      const childIds = getContainerChildIds(document, target.node.id);
      if (target.node.id === dragged.containerId) {
        documentStore.apply({
          type: "reorder-node",
          containerId: dragged.containerId,
          nodeId: dragged.node.id,
          toIndex: childIds.length - 1,
        });
      } else {
        moveUnitToContainer(dragged.node.id, target.node.id, childIds.length);
      }
      return;
    }

    // Dropping onto a row in another container moves it there (into or
    // out of groups); within one container it stays a reorder.
    if (dragged.containerId !== target.containerId) {
      moveUnitToContainer(dragged.node.id, target.containerId, target.zIndex);
      return;
    }
    documentStore.apply({
      type: "reorder-node",
      containerId: dragged.containerId,
      nodeId: dragged.node.id,
      toIndex: target.zIndex,
    });
  }

  return (
    <section className="inspector-section">
      <h2>Layers</h2>
      <div className="layer-rows">
        {rows.map((row, rowIndex) => {
          const { node } = row;
          const Icon = NODE_ICONS[node.type];
          const selected = selectedNodeIds.includes(node.id);
          const isGroup = node.type === "group";
          return (
            <div
              key={node.id}
              className={`layer-row ${selected ? "active" : ""} ${
                node.visible ? "" : "is-hidden"
              } ${dropRow === rowIndex ? "drop-target" : ""}`}
              style={row.depth > 0 ? { paddingLeft: row.depth * 14 } : undefined}
              draggable
              onDragStart={(event) => {
                dragRef.current = row;
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                event.preventDefault();
                if (dropRow !== rowIndex) {
                  setDropRow(rowIndex);
                }
              }}
              onDragLeave={() => setDropRow(null)}
              onDrop={(event) => {
                event.preventDefault();
                handleDrop(row);
              }}
              onDragEnd={() => {
                dragRef.current = null;
                setDropRow(null);
              }}
            >
              {isGroup && (
                <button
                  type="button"
                  className="layer-toggle"
                  onClick={() => toggleExpanded(node.id)}
                  title={expanded.has(node.id) ? "Collapse" : "Expand"}
                  aria-label={
                    expanded.has(node.id) ? "Collapse group" : "Expand group"
                  }
                >
                  {expanded.has(node.id) ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRight size={13} />
                  )}
                </button>
              )}
              <button
                type="button"
                className="layer-main"
                onClick={(event) =>
                  setSelection(
                    event.shiftKey && !selected
                      ? [...selectedNodeIds, node.id]
                      : [node.id],
                  )
                }
                onDoubleClick={() => {
                  if (isGroup) {
                    setActiveGroupId(node.id);
                    toggleExpanded(node.id);
                  }
                }}
              >
                <Icon size={13} strokeWidth={1.75} />
                <span>{node.name}</span>
              </button>
              <button
                type="button"
                className="layer-toggle"
                onClick={() => toggle(node.id, { visible: !node.visible })}
                title={node.visible ? "Hide" : "Show"}
                aria-label={node.visible ? "Hide layer" : "Show layer"}
              >
                {node.visible ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <button
                type="button"
                className={`layer-toggle ${node.locked ? "is-on" : ""}`}
                onClick={() => toggle(node.id, { locked: !node.locked })}
                title={node.locked ? "Unlock" : "Lock"}
                aria-label={node.locked ? "Unlock layer" : "Lock layer"}
              >
                {node.locked ? <Lock size={13} /> : <Unlock size={13} />}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AssistantSection() {
  const review = useEditorStore((state) => state.review);
  const setReview = useEditorStore((state) => state.setReview);

  return (
    <section className="inspector-section">
      <h2>Design mate</h2>
      <button
        type="button"
        className="primary-button"
        onClick={() => setReview(analyzeLogoDocument(documentStore.document))}
      >
        <Sparkles size={14} />
        Review active logo
      </button>
      {review && (
        <div className="agent-review">
          {review.findings.length === 0 ? (
            <p className="muted">No issues found in this pass.</p>
          ) : (
            <ul>
              {review.findings.map((finding) => (
                <li
                  key={`${finding.title}-${finding.detail}`}
                  data-severity={finding.severity}
                >
                  <span>{finding.title}</span>
                  <p>{finding.detail}</p>
                  <em>{finding.action}</em>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function MultiDesignSection({
  nodes,
  patchSelection,
}: {
  nodes: LogoNode[];
  patchSelection: (patch: NodePatch) => void;
}) {
  const document = useDocument();
  // Show the first drawable leaf's paint (a group's fill is a placeholder).
  const firstLeafId = collectLeafNodeIds(
    document,
    nodes.map((node) => node.id),
  )[0];
  const first = (firstLeafId && document.nodes[firstLeafId]) || nodes[0]!;
  const fillColor = first.fill.type === "solid" ? first.fill.color : "#000000";

  return (
    <section className="inspector-section">
      <h2>Design</h2>
      <p className="muted" style={{ marginBottom: 10 }}>
        {nodes.length} objects selected
      </p>
      <AlignPanel nodeIds={nodes.map((node) => node.id)} />
      <div className="fill-row">
        <input
          type="color"
          className="fill-swatch"
          value={fillColor}
          onChange={(event) =>
            patchSelection({
              fill: { type: "solid", color: event.target.value },
            })
          }
          aria-label="Fill color"
        />
        <div className="opacity-field">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={first.opacity}
            onChange={(event) =>
              patchSelection({ opacity: Number(event.target.value) })
            }
            aria-label="Opacity"
          />
          <span>{Math.round(first.opacity * 100)}%</span>
        </div>
      </div>
      <div className="swatch-row">
        {document.palettes[0]?.colors.map((color) => (
          <button
            key={color}
            type="button"
            className="swatch"
            style={{ background: color }}
            aria-label={`Use ${color}`}
            onClick={() => patchSelection({ fill: { type: "solid", color } })}
          />
        ))}
      </div>
    </section>
  );
}

export function Inspector() {
  const document = useDocument();
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  // Selection may reach inside groups, so look nodes up directly.
  const selectedNodes = selectedNodeIds
    .map((id) => document.nodes[id])
    .filter((node): node is LogoNode => Boolean(node));

  // Paint/typography patches always land on drawable leaves; a selected
  // group fans the patch out to its descendants.
  function patchSelection(patch: NodePatch) {
    const leafIds = collectLeafNodeIds(document, selectedNodeIds);
    if (leafIds.length === 0) {
      return;
    }
    documentStore.apply({
      type: "update-nodes",
      updates: leafIds.map((nodeId) => ({ nodeId, patch })),
    });
  }

  return (
    <aside className="inspector" aria-label="Inspector">
      {selectedNodes.length > 1 ? (
        <MultiDesignSection
          nodes={selectedNodes}
          patchSelection={patchSelection}
        />
      ) : selectedNodes.length === 1 && selectedNodes[0]!.type === "group" ? (
        <GroupSection group={selectedNodes[0] as GroupNode} />
      ) : selectedNodes.length === 1 ? (
        <DesignSection node={selectedNodes[0]!} patchSelection={patchSelection} />
      ) : (
        <section className="inspector-section">
          <h2>Design</h2>
          <p className="muted">Select an object to edit its properties.</p>
        </section>
      )}
      <SwatchesSection />
      <LayersSection />
      <AssistantSection />
    </aside>
  );
}
