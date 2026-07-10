import { getActiveArtboard, isGradient } from "@openlogo/core";
import { worldToScreen } from "@openlogo/renderer";
import { useLiveDocument } from "../state/document";
import { useEditorStore } from "../state/editor-store";
import { gradientHandlePoints } from "./gradient-annotator";

const LINE = "#4f6bf6";

/**
 * Visual layer of the gradient annotator (G tool): the gradient line
 * with draggable-looking endpoints for linear fills, centre/radius (and
 * focal) handles for radial fills. Purely presentational — CanvasStage's
 * pointer handlers own the interaction, so wheel/pan/space behaviour on
 * the canvas is untouched (pointer-events: none throughout).
 */
export function GradientAnnotator() {
  const document = useLiveDocument();
  const camera = useEditorStore((state) => state.camera);
  const tool = useEditorStore((state) => state.tool);
  const selectedNodeIds = useEditorStore((state) => state.selectedNodeIds);

  if (tool !== "gradient" || selectedNodeIds.length !== 1) {
    return null;
  }
  const node = document.nodes[selectedNodeIds[0]!];
  if (!node || node.type === "group") {
    return null;
  }

  const artboard = getActiveArtboard(document);
  const toScreen = (p: { x: number; y: number }) =>
    worldToScreen(camera, { x: p.x + artboard.x, y: p.y + artboard.y });

  if (!isGradient(node.fill)) {
    return (
      <div className="pointer-events-none absolute bottom-52 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-full border border-[rgb(255_255_255/0.07)] bg-[rgb(23_21_27/0.88)] px-13 py-6 text-[11.5px] text-[#e8e6ee]">
        Drag across the shape to apply a gradient
      </div>
    );
  }

  const handles = gradientHandlePoints(node).map((handle) => ({
    part: handle.part,
    screen: toScreen(handle),
  }));
  const byPart = Object.fromEntries(
    handles.map((handle) => [handle.part, handle.screen]),
  );

  const chip = (x: number, y: number, part: string, round: boolean) => (
    <g key={part} data-gradient-handle={part}>
      <circle
        cx={x}
        cy={y}
        r={round ? 6 : 5.5}
        fill="#ffffff"
        stroke={LINE}
        strokeWidth={1.5}
        {...(round ? {} : { rx: 1 })}
      />
      <circle cx={x} cy={y} r={2} fill={LINE} />
    </g>
  );

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-10 h-full w-full"
      data-testid="gradient-annotator"
      aria-hidden="true"
    >
      {node.fill.type === "linear-gradient" && byPart.start && byPart.end && (
        <>
          <line
            x1={byPart.start.x}
            y1={byPart.start.y}
            x2={byPart.end.x}
            y2={byPart.end.y}
            stroke={LINE}
            strokeWidth={1.5}
          />
          {chip(byPart.start.x, byPart.start.y, "start", true)}
          {chip(byPart.end.x, byPart.end.y, "end", false)}
        </>
      )}
      {node.fill.type === "radial-gradient" && byPart.center && byPart.radius && (
        <>
          <line
            x1={byPart.center.x}
            y1={byPart.center.y}
            x2={byPart.radius.x}
            y2={byPart.radius.y}
            stroke={LINE}
            strokeWidth={1.5}
          />
          <ellipse
            cx={byPart.center.x}
            cy={byPart.center.y}
            rx={Math.hypot(
              byPart.radius.x - byPart.center.x,
              byPart.radius.y - byPart.center.y,
            )}
            ry={
              node.fill.r * node.height * camera.zoom
            }
            fill="none"
            stroke={LINE}
            strokeWidth={1}
            strokeDasharray="4 3"
            opacity={0.6}
            transform={`rotate(${node.rotation} ${byPart.center.x} ${byPart.center.y})`}
          />
          {chip(byPart.center.x, byPart.center.y, "center", true)}
          {chip(byPart.radius.x, byPart.radius.y, "radius", false)}
          {byPart.focal && chip(byPart.focal.x, byPart.focal.y, "focal", true)}
        </>
      )}
    </svg>
  );
}
