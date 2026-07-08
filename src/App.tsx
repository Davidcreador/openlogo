import { useMemo, useRef, useState } from "react";
import {
  type LogoDocument,
  type LogoNode,
  type LogoVariant,
  type SelectionBounds,
  type Tool,
  createId,
  createInitialDocument,
  duplicateArtboard,
  getActiveArtboard,
  getNodesForArtboard,
  getSelectionBounds,
} from "./lib/document";
import { type AgentReview, analyzeLogoDocument } from "./lib/agent";
import {
  documentToSvg,
  downloadPngFromSvg,
  downloadTextFile,
} from "./lib/export";

type DragState = {
  mode: "move" | "resize";
  start: Point;
  nodeSnapshots: Record<string, LogoNode>;
};

type Point = {
  x: number;
  y: number;
};

const tools: Array<{ id: Tool; label: string; shortcut: string }> = [
  { id: "select", label: "Select", shortcut: "V" },
  { id: "rectangle", label: "Rectangle", shortcut: "R" },
  { id: "ellipse", label: "Ellipse", shortcut: "O" },
  { id: "path", label: "Mark", shortcut: "P" },
  { id: "text", label: "Text", shortcut: "T" },
];

const variantOptions: Array<{ id: LogoVariant; label: string }> = [
  { id: "icon", label: "Icon" },
  { id: "wordmark", label: "Wordmark" },
  { id: "horizontal", label: "Horizontal" },
  { id: "stacked", label: "Stacked" },
];

function cloneNode(node: LogoNode): LogoNode {
  return { ...node, fill: { ...node.fill }, stroke: node.stroke && { ...node.stroke } };
}

function makeNode(type: Tool, point: Point, fillColor: string): LogoNode {
  const base = {
    id: createId("node"),
    name: "Node",
    x: Math.round(point.x - 48),
    y: Math.round(point.y - 32),
    width: 96,
    height: 64,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    fill: { type: "solid" as const, value: fillColor },
  };

  if (type === "ellipse") {
    return {
      ...base,
      type: "ellipse",
      name: "Ellipse mark",
      width: 88,
      height: 88,
      y: Math.round(point.y - 44),
    };
  }

  if (type === "text") {
    return {
      ...base,
      type: "text",
      name: "Wordmark",
      width: 210,
      height: 56,
      content: "Brand",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      fontSize: 44,
      fontWeight: 700,
      letterSpacing: -1,
    };
  }

  if (type === "path") {
    return {
      ...base,
      type: "path",
      name: "Custom mark",
      width: 92,
      height: 92,
      y: Math.round(point.y - 46),
      d: "M48 4 C68 4 84 20 84 40 C84 66 62 78 48 92 C34 78 12 66 12 40 C12 20 28 4 48 4 Z M48 22 C38 30 32 38 32 48 C32 58 39 66 48 70 C57 66 64 58 64 48 C64 38 58 30 48 22 Z",
    };
  }

  return {
    ...base,
    type: "rectangle",
    name: "Rectangle shape",
    cornerRadius: 16,
  };
}

function renderSvgNode(node: LogoNode, isSelected: boolean) {
  const commonProps = {
    "data-node-id": node.id,
    opacity: node.opacity,
    fill: node.fill.value,
    stroke: isSelected ? "#2563eb" : node.stroke?.color,
    strokeWidth: isSelected ? Math.max(2, node.stroke?.width ?? 0) : node.stroke?.width,
    vectorEffect: "non-scaling-stroke" as const,
    className: `canvas-node ${isSelected ? "is-selected" : ""}`,
  };

  const rotate = `rotate(${node.rotation} ${node.x + node.width / 2} ${
    node.y + node.height / 2
  })`;

  if (!node.visible) {
    return null;
  }

  if (node.type === "rectangle") {
    return (
      <rect
        key={node.id}
        {...commonProps}
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx={node.cornerRadius ?? 0}
        transform={rotate}
      />
    );
  }

  if (node.type === "ellipse") {
    return (
      <ellipse
        key={node.id}
        {...commonProps}
        cx={node.x + node.width / 2}
        cy={node.y + node.height / 2}
        rx={node.width / 2}
        ry={node.height / 2}
        transform={rotate}
      />
    );
  }

  if (node.type === "text") {
    return (
      <text
        key={node.id}
        {...commonProps}
        x={node.x}
        y={node.y + node.fontSize}
        fontFamily={node.fontFamily}
        fontSize={node.fontSize}
        fontWeight={node.fontWeight}
        letterSpacing={node.letterSpacing}
        transform={rotate}
      >
        {node.content}
      </text>
    );
  }

  if (node.type === "path") {
    return (
      <path
        key={node.id}
        {...commonProps}
        d={node.d}
        transform={`translate(${node.x} ${node.y}) scale(${node.width / 96} ${
          node.height / 96
        })`}
      />
    );
  }

  return null;
}

function selectedSnapshot(nodes: LogoNode[], selectedNodeIds: string[]) {
  return Object.fromEntries(
    nodes
      .filter((node) => selectedNodeIds.includes(node.id))
      .map((node) => [node.id, cloneNode(node)]),
  );
}

function formatPurpose(value: LogoVariant): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export default function App() {
  const [documentState, setDocumentState] = useState<LogoDocument>(() =>
    createInitialDocument(),
  );
  const [tool, setTool] = useState<Tool>("select");
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [fillColor, setFillColor] = useState("#111827");
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [undoStack, setUndoStack] = useState<LogoDocument[]>([]);
  const [redoStack, setRedoStack] = useState<LogoDocument[]>([]);
  const [review, setReview] = useState<AgentReview | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const artboard = getActiveArtboard(documentState);
  const activeNodes = useMemo(
    () => getNodesForArtboard(documentState),
    [documentState],
  );
  const selectionBounds = useMemo(
    () => getSelectionBounds(activeNodes, selectedNodeIds),
    [activeNodes, selectedNodeIds],
  );
  const selectedNodes = activeNodes.filter((node) =>
    selectedNodeIds.includes(node.id),
  );
  const firstSelectedNode = selectedNodes[0];

  function pushHistory(current: LogoDocument = documentState) {
    setUndoStack((stack) => [...stack.slice(-24), current]);
    setRedoStack([]);
  }

  function commitDocument(nextDocument: LogoDocument) {
    pushHistory();
    setDocumentState(nextDocument);
  }

  function updateSelectedNodes(
    updater: (node: LogoNode) => LogoNode,
    commit = true,
  ) {
    if (selectedNodeIds.length === 0) {
      return;
    }

    if (commit) {
      pushHistory();
    }

    setDocumentState((current) => ({
      ...current,
      nodes: Object.fromEntries(
        Object.entries(current.nodes).map(([id, node]) => [
          id,
          selectedNodeIds.includes(id) ? updater(node) : node,
        ]),
      ),
    }));
  }

  function getPointer(event: React.PointerEvent<SVGSVGElement>): Point {
    const svg = svgRef.current;

    if (!svg) {
      return { x: 0, y: 0 };
    }

    const rect = svg.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * artboard.width,
      y: ((event.clientY - rect.top) / rect.height) * artboard.height,
    };
  }

  function addNode(type: Tool, point: Point) {
    const node = makeNode(type, point, fillColor);
    const nextDocument: LogoDocument = {
      ...documentState,
      nodes: {
        ...documentState.nodes,
        [node.id]: node,
      },
      artboards: documentState.artboards.map((item) =>
        item.id === artboard.id
          ? { ...item, nodeIds: [...item.nodeIds, node.id] }
          : item,
      ),
    };

    commitDocument(nextDocument);
    setSelectedNodeIds([node.id]);
    setTool("select");
  }

  function handleCanvasPointerDown(event: React.PointerEvent<SVGSVGElement>) {
    const point = getPointer(event);
    const target = event.target as SVGElement;
    const nodeElement = target.closest("[data-node-id]") as SVGElement | null;
    const nodeId = nodeElement?.dataset.nodeId;

    if (tool !== "select") {
      addNode(tool, point);
      return;
    }

    if (!nodeId) {
      setSelectedNodeIds([]);
      return;
    }

    const nextSelection = event.shiftKey
      ? selectedNodeIds.includes(nodeId)
        ? selectedNodeIds.filter((id) => id !== nodeId)
        : [...selectedNodeIds, nodeId]
      : [nodeId];

    setSelectedNodeIds(nextSelection);
    pushHistory();
    setDragState({
      mode: "move",
      start: point,
      nodeSnapshots: selectedSnapshot(activeNodes, nextSelection),
    });
  }

  function handleCanvasPointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (!dragState) {
      return;
    }

    const point = getPointer(event);
    const deltaX = point.x - dragState.start.x;
    const deltaY = point.y - dragState.start.y;

    setDocumentState((current) => ({
      ...current,
      nodes: Object.fromEntries(
        Object.entries(current.nodes).map(([id, node]) => {
          const snapshot = dragState.nodeSnapshots[id];

          if (!snapshot) {
            return [id, node];
          }

          if (dragState.mode === "resize") {
            return [
              id,
              {
                ...node,
                width: Math.max(12, snapshot.width + deltaX),
                height: Math.max(12, snapshot.height + deltaY),
              },
            ];
          }

          return [
            id,
            {
              ...node,
              x: snapshot.x + deltaX,
              y: snapshot.y + deltaY,
            },
          ];
        }),
      ),
    }));
  }

  function handleResizePointerDown(event: React.PointerEvent<SVGRectElement>) {
    event.stopPropagation();

    if (!selectionBounds) {
      return;
    }

    const point = getPointer(event as unknown as React.PointerEvent<SVGSVGElement>);
    pushHistory();
    setDragState({
      mode: "resize",
      start: point,
      nodeSnapshots: selectedSnapshot(activeNodes, selectedNodeIds),
    });
  }

  function undo() {
    const previous = undoStack.at(-1);

    if (!previous) {
      return;
    }

    setRedoStack((stack) => [documentState, ...stack]);
    setUndoStack((stack) => stack.slice(0, -1));
    setDocumentState(previous);
    setSelectedNodeIds([]);
  }

  function redo() {
    const next = redoStack[0];

    if (!next) {
      return;
    }

    setUndoStack((stack) => [...stack, documentState]);
    setRedoStack((stack) => stack.slice(1));
    setDocumentState(next);
    setSelectedNodeIds([]);
  }

  function deleteSelection() {
    if (selectedNodeIds.length === 0) {
      return;
    }

    const nextNodes = { ...documentState.nodes };
    for (const nodeId of selectedNodeIds) {
      delete nextNodes[nodeId];
    }

    commitDocument({
      ...documentState,
      nodes: nextNodes,
      artboards: documentState.artboards.map((item) => ({
        ...item,
        nodeIds: item.nodeIds.filter((nodeId) => !selectedNodeIds.includes(nodeId)),
      })),
    });
    setSelectedNodeIds([]);
  }

  function createVariant(purpose: LogoVariant) {
    const nextDocument = duplicateArtboard(documentState, purpose);
    commitDocument(nextDocument);
    setSelectedNodeIds([]);
  }

  function exportSvg() {
    const svg = documentToSvg(documentState);
    downloadTextFile(svg, `${artboard.name.toLowerCase().replaceAll(" ", "-")}.svg`, "image/svg+xml");
  }

  async function exportPng() {
    const svg = documentToSvg(documentState);
    await downloadPngFromSvg(
      svg,
      `${artboard.name.toLowerCase().replaceAll(" ", "-")}@2x.png`,
    );
  }

  function renderSelection(bounds: SelectionBounds | null) {
    if (!bounds) {
      return null;
    }

    return (
      <g className="selection-outline">
        <rect
          x={bounds.x}
          y={bounds.y}
          width={bounds.width}
          height={bounds.height}
          fill="none"
          stroke="#2563eb"
          strokeDasharray="7 5"
          vectorEffect="non-scaling-stroke"
        />
        <rect
          className="resize-handle"
          x={bounds.x + bounds.width - 6}
          y={bounds.y + bounds.height - 6}
          width={12}
          height={12}
          rx={3}
          onPointerDown={handleResizePointerDown}
        />
      </g>
    );
  }

  return (
    <main className="app-shell">
      <aside className="left-rail" aria-label="OpenLogo tools">
        <div className="brand-lockup">
          <span className="brand-mark">OL</span>
          <div>
            <strong>OpenLogo</strong>
            <small>Manual-first logo studio</small>
          </div>
        </div>

        <div className="tool-stack">
          {tools.map((item) => (
            <button
              className={tool === item.id ? "active" : ""}
              key={item.id}
              type="button"
              onClick={() => setTool(item.id)}
            >
              <span>{item.label}</span>
              <kbd>{item.shortcut}</kbd>
            </button>
          ))}
        </div>

        <section className="panel">
          <h2>Variants</h2>
          <div className="variant-grid">
            {variantOptions.map((variant) => (
              <button key={variant.id} type="button" onClick={() => createVariant(variant.id)}>
                + {variant.label}
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>Artboards</h2>
          <div className="layer-list">
            {documentState.artboards.map((item) => (
              <button
                key={item.id}
                className={item.id === artboard.id ? "active layer-item" : "layer-item"}
                type="button"
                onClick={() =>
                  setDocumentState((current) => ({
                    ...current,
                    activeArtboardId: item.id,
                  }))
                }
              >
                <span>{item.name}</span>
                <small>{formatPurpose(item.purpose)}</small>
              </button>
            ))}
          </div>
        </section>
      </aside>

      <section className="workspace" aria-label="Logo canvas workspace">
        <header className="top-bar">
          <div>
            <strong>{artboard.name}</strong>
            <span>{artboard.width} x {artboard.height}</span>
          </div>
          <div className="top-actions">
            <button type="button" onClick={undo} disabled={undoStack.length === 0}>
              Undo
            </button>
            <button type="button" onClick={redo} disabled={redoStack.length === 0}>
              Redo
            </button>
            <button type="button" onClick={deleteSelection} disabled={selectedNodeIds.length === 0}>
              Delete
            </button>
            <button type="button" onClick={exportSvg}>
              Export SVG
            </button>
            <button type="button" onClick={() => void exportPng()}>
              Export PNG
            </button>
          </div>
        </header>

        <div className="canvas-wrap">
          <svg
            ref={svgRef}
            className="logo-canvas"
            viewBox={`0 0 ${artboard.width} ${artboard.height}`}
            role="img"
            aria-label="OpenLogo SVG editor canvas"
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={() => setDragState(null)}
            onPointerLeave={() => setDragState(null)}
          >
            <defs>
              <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#dbeafe" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill={artboard.background} />
            <rect width="100%" height="100%" fill="url(#grid)" opacity="0.55" />
            {activeNodes.map((node) =>
              renderSvgNode(node, selectedNodeIds.includes(node.id)),
            )}
            {renderSelection(selectionBounds)}
          </svg>
        </div>

        <section className="preview-strip" aria-label="Logo production previews">
          {[128, 64, 32, 16].map((size) => (
            <div className="preview-card" key={size}>
              <span>{size}px</span>
              <svg
                viewBox={`0 0 ${artboard.width} ${artboard.height}`}
                width={size}
                height={Math.max(16, Math.round((size * artboard.height) / artboard.width))}
                aria-hidden="true"
              >
                <rect width="100%" height="100%" fill="#ffffff" />
                {activeNodes.map((node) => renderSvgNode(node, false))}
              </svg>
            </div>
          ))}
        </section>
      </section>

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
                    updateSelectedNodes((node) => ({
                      ...node,
                      name: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Fill
                <input
                  type="color"
                  value={firstSelectedNode.fill.value}
                  onChange={(event) => {
                    setFillColor(event.target.value);
                    updateSelectedNodes((node) => ({
                      ...node,
                      fill: { type: "solid", value: event.target.value },
                    }));
                  }}
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
                    updateSelectedNodes((node) => ({
                      ...node,
                      opacity: Number(event.target.value),
                    }))
                  }
                />
              </label>
              <label>
                Rotation
                <input
                  type="number"
                  value={firstSelectedNode.rotation}
                  onChange={(event) =>
                    updateSelectedNodes((node) => ({
                      ...node,
                      rotation: Number(event.target.value),
                    }))
                  }
                />
              </label>

              {firstSelectedNode.type === "text" && (
                <>
                  <label>
                    Text
                    <input
                      value={firstSelectedNode.content}
                      onChange={(event) =>
                        updateSelectedNodes((node) =>
                          node.type === "text"
                            ? { ...node, content: event.target.value }
                            : node,
                        )
                      }
                    />
                  </label>
                  <label>
                    Font size
                    <input
                      type="number"
                      value={firstSelectedNode.fontSize}
                      onChange={(event) =>
                        updateSelectedNodes((node) =>
                          node.type === "text"
                            ? { ...node, fontSize: Number(event.target.value) }
                            : node,
                        )
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
                        updateSelectedNodes((node) =>
                          node.type === "text"
                            ? {
                                ...node,
                                letterSpacing: Number(event.target.value),
                              }
                            : node,
                        )
                      }
                    />
                  </label>
                  <label>
                    Weight
                    <select
                      value={firstSelectedNode.fontWeight}
                      onChange={(event) =>
                        updateSelectedNodes((node) =>
                          node.type === "text"
                            ? {
                                ...node,
                                fontWeight: Number(event.target.value),
                              }
                            : node,
                        )
                      }
                    >
                      <option value={400}>Regular</option>
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
              Select a shape or wordmark to tune fill, opacity, rotation, and type settings.
            </p>
          )}
        </section>

        <section className="panel">
          <h2>Palette</h2>
          <div className="swatches">
            {documentState.palettes[0]?.colors.map((color) => (
              <button
                key={color}
                type="button"
                style={{ background: color }}
                aria-label={`Use ${color}`}
                onClick={() => {
                  setFillColor(color);
                  updateSelectedNodes((node) => ({
                    ...node,
                    fill: { type: "solid", value: color },
                  }));
                }}
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
                  selectedNodeIds.includes(node.id) ? "active layer-item" : "layer-item"
                }
                type="button"
                onClick={() => setSelectedNodeIds([node.id])}
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
            Local first pass for logo craft checks. Later this becomes the full agent tool surface.
          </p>
          <button type="button" className="primary-button" onClick={() => setReview(analyzeLogoDocument(documentState))}>
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
                    <li key={`${finding.title}-${finding.detail}`} data-severity={finding.severity}>
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
    </main>
  );
}
