import type { Command } from "./commands";
import { cloneArtboardForVariant } from "./factory";
import { nextArtboardPosition } from "./queries";
import type { LogoDocument, LogoVariant } from "./types";

export type AddArtboardCommand = Extract<Command, { type: "add-artboard" }>;

export type BuildAddVariantCommandOptions = {
  /**
   * Whether applying the command should activate the new variant. Manual
   * variant creation keeps the existing add-artboard default of activating it.
   */
  readonly activate?: boolean;
};

/**
 * Build the complete command for a non-destructive logo variant clone.
 *
 * The cloned artboard is placed beside its source and pushed past any
 * overlapping artboards. Neither the document nor any object reachable from
 * it is mutated.
 */
export function buildAddVariantCommand(
  document: LogoDocument,
  sourceArtboardId: string,
  purpose: LogoVariant,
  options: BuildAddVariantCommandOptions = {},
): AddArtboardCommand {
  const { artboard: clonedArtboard, nodes } = cloneArtboardForVariant(
    document,
    sourceArtboardId,
    purpose,
  );
  const position = nextArtboardPosition(document, sourceArtboardId, {
    width: clonedArtboard.width,
    height: clonedArtboard.height,
  });

  return {
    type: "add-artboard",
    artboard: {
      ...clonedArtboard,
      ...position,
    },
    nodes,
    activate: options.activate ?? true,
  };
}
