import { useEffect, useState } from "react";
import {
  Circle,
  Eye,
  EyeOff,
  Lock,
  PenTool,
  Sparkles,
  Square,
  Type,
  Unlock,
} from "lucide-react";
import {
  type LogoNode,
  type NodePatch,
  analyzeLogoDocument,
  getNodesForArtboard,
} from "@openlogo/core";
import {
  FONT_CATALOG,
  catalogEntry,
  fontStore,
  nearestWeight,
} from "../lib/font-store";
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

function DesignSection({
  node,
  patchSelection,
}: {
  node: LogoNode;
  patchSelection: (patch: NodePatch) => void;
}) {
  const document = useDocument();
  const setSelection = useEditorStore((state) => state.setSelection);
  const fillColor = node.fill.type === "solid" ? node.fill.color : "#000000";

  return (
    <section className="inspector-section">
      <h2>Design</h2>

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

      <div className="fill-row">
        <input
          type="color"
          className="fill-swatch"
          value={fillColor}
          onChange={(event) =>
            patchSelection({ fill: { type: "solid", color: event.target.value } })
          }
          aria-label="Fill color"
        />
        <input
          className="fill-hex"
          value={fillColor.toUpperCase()}
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

function LayersSection() {
  const document = useDocument();
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const setSelection = useEditorStore((state) => state.setSelection);
  const activeNodes = getNodesForArtboard(document);

  function toggle(nodeId: string, patch: NodePatch) {
    documentStore.apply({ type: "update-nodes", updates: [{ nodeId, patch }] });
  }

  return (
    <section className="inspector-section">
      <h2>Layers</h2>
      <div className="layer-rows">
        {[...activeNodes].reverse().map((node) => {
          const Icon = NODE_ICONS[node.type];
          const selected = selectedNodeIds.includes(node.id);
          return (
            <div
              key={node.id}
              className={`layer-row ${selected ? "active" : ""} ${
                node.visible ? "" : "is-hidden"
              }`}
            >
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

export function Inspector() {
  const document = useDocument();
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const activeNodes = getNodesForArtboard(document);
  const firstSelectedNode = activeNodes.find((node) =>
    selectedNodeIds.includes(node.id),
  );

  function patchSelection(patch: NodePatch) {
    if (selectedNodeIds.length === 0) {
      return;
    }
    documentStore.apply({
      type: "update-nodes",
      updates: selectedNodeIds.map((nodeId) => ({ nodeId, patch })),
    });
  }

  return (
    <aside className="inspector" aria-label="Inspector">
      {firstSelectedNode ? (
        <DesignSection
          node={firstSelectedNode}
          patchSelection={patchSelection}
        />
      ) : (
        <section className="inspector-section">
          <h2>Design</h2>
          <p className="muted">Select an object to edit its properties.</p>
        </section>
      )}
      <LayersSection />
      <AssistantSection />
    </aside>
  );
}
