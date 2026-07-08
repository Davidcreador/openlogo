import type { Command } from "@openlogo/core";
import { documentStore } from "../state/document";

/**
 * Global swatch edit: change a palette colour and recolour every node
 * fill/stroke that used the old value, atomically (one undo).
 */
export function editSwatch(
  paletteId: string,
  index: number,
  nextColor: string,
): void {
  const document = documentStore.document;
  const palette = document.palettes.find((item) => item.id === paletteId);
  const oldColor = palette?.colors[index];
  if (!palette || oldColor === undefined || oldColor === nextColor) {
    return;
  }

  const colors = palette.colors.map((color, i) =>
    i === index ? nextColor : color,
  );

  const updates = Object.values(document.nodes)
    .map((node) => {
      const fillMatch =
        node.fill.type === "solid" &&
        node.fill.color.toLowerCase() === oldColor.toLowerCase();
      const strokeMatch =
        node.stroke &&
        node.stroke.color.toLowerCase() === oldColor.toLowerCase();
      if (!fillMatch && !strokeMatch) {
        return null;
      }
      return {
        nodeId: node.id,
        patch: {
          ...(fillMatch
            ? { fill: { type: "solid" as const, color: nextColor } }
            : {}),
          ...(strokeMatch && node.stroke
            ? { stroke: { ...node.stroke, color: nextColor } }
            : {}),
        },
      };
    })
    .filter((update): update is NonNullable<typeof update> => update !== null);

  const commands: Command[] = [
    { type: "update-palette", paletteId, colors },
  ];
  if (updates.length > 0) {
    commands.push({ type: "update-nodes", updates });
  }

  documentStore.apply({ type: "batch", label: "Edit swatch", commands });
}
