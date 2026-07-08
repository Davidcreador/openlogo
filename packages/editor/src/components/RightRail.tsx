import {
  type LogoNode,
  type NodePatch,
  analyzeLogoDocument,
  getNodesForArtboard,
} from "@openlogo/core";
import { documentStore, useDocument } from "../state/document";
import { useEditorStore } from "../state/editor-store";

export function RightRail() {
  const document = useDocument();
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);
  const setSelection = useEditorStore((state) => state.setSelection);
  const review = useEditorStore((state) => state.review);
  const setReview = useEditorStore((state) => state.setReview);

  const activeNodes = getNodesForArtboard(document);
  const selectedNodes = activeNodes.filter((node) =>
    selectedNodeIds.includes(node.id),
  );
  const firstSelectedNode: LogoNode | undefined = selectedNodes[0];

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
    <aside className="right-rail" aria-label="Properties and assistant panels">
      <section className="panel">
        <h2>Properties</h2>
        {firstSelectedNode ? (
          <div className="properties">
            <label>
              Name
              <input
                value={firstSelectedNode.name}
                onChange={(event) =>
                  patchSelection({ name: event.target.value })
                }
              />
            </label>
            <label>
              Fill
              <input
                type="color"
                value={
                  firstSelectedNode.fill.type === "solid"
                    ? firstSelectedNode.fill.color
                    : "#000000"
                }
                onChange={(event) =>
                  patchSelection({
                    fill: { type: "solid", color: event.target.value },
                  })
                }
              />
            </label>
            <label>
              Opacity
              <input
                type="range"
                min="0.05"
                max="1"
                step="0.05"
                value={firstSelectedNode.opacity}
                onChange={(event) =>
                  patchSelection({ opacity: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Rotation
              <input
                type="number"
                value={firstSelectedNode.rotation}
                onChange={(event) =>
                  patchSelection({ rotation: Number(event.target.value) })
                }
              />
            </label>

            {firstSelectedNode.type === "rectangle" && (
              <label>
                Corner radius
                <input
                  type="number"
                  min="0"
                  value={firstSelectedNode.cornerRadius}
                  onChange={(event) =>
                    patchSelection({
                      cornerRadius: Math.max(0, Number(event.target.value)),
                    })
                  }
                />
              </label>
            )}

            {firstSelectedNode.type === "text" && (
              <>
                <label>
                  Text
                  <input
                    value={firstSelectedNode.content}
                    onChange={(event) =>
                      patchSelection({ content: event.target.value })
                    }
                  />
                </label>
                <label>
                  Font size
                  <input
                    type="number"
                    value={Math.round(firstSelectedNode.fontSize)}
                    onChange={(event) =>
                      patchSelection({ fontSize: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  Letter spacing
                  <input
                    type="number"
                    step="0.1"
                    value={firstSelectedNode.letterSpacing}
                    onChange={(event) =>
                      patchSelection({
                        letterSpacing: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Weight
                  <select
                    value={firstSelectedNode.fontWeight}
                    onChange={(event) =>
                      patchSelection({ fontWeight: Number(event.target.value) })
                    }
                  >
                    <option value={400}>Regular</option>
                    <option value={500}>Medium</option>
                    <option value={600}>Semibold</option>
                    <option value={700}>Bold</option>
                    <option value={800}>Extra bold</option>
                  </select>
                </label>
              </>
            )}
          </div>
        ) : (
          <p className="muted">
            Select a shape or wordmark to tune fill, opacity, rotation, and
            type settings.
          </p>
        )}
      </section>

      <section className="panel">
        <h2>Palette</h2>
        <div className="swatches">
          {document.palettes[0]?.colors.map((color) => (
            <button
              key={color}
              type="button"
              style={{ background: color }}
              aria-label={`Use ${color}`}
              onClick={() =>
                patchSelection({ fill: { type: "solid", color } })
              }
            />
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Layers</h2>
        <div className="layer-list">
          {[...activeNodes].reverse().map((node) => (
            <button
              key={node.id}
              className={
                selectedNodeIds.includes(node.id)
                  ? "active layer-item"
                  : "layer-item"
              }
              type="button"
              onClick={() => setSelection([node.id])}
            >
              <span>{node.name}</span>
              <small>{node.type}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="panel agent-panel">
        <h2>Design mate</h2>
        <p className="muted">
          Local first pass for logo craft checks. Later this becomes the full
          agent tool surface.
        </p>
        <button
          type="button"
          className="primary-button"
          onClick={() => setReview(analyzeLogoDocument(documentStore.document))}
        >
          Review active logo
        </button>
        {review && (
          <div className="agent-review">
            <strong>{review.summary}</strong>
            {review.findings.length === 0 ? (
              <p>No issues found in this pass.</p>
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
    </aside>
  );
}
