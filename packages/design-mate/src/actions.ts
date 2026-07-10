import type {
  DesignMateAction,
  DesignMateMutationToolMetadata,
} from "./contracts";

/**
 * Read-only registry for the complete mutation surface. Providers can expose
 * these descriptions as tool metadata without granting arbitrary commands.
 */
export const DESIGN_MATE_MUTATION_TOOLS = Object.freeze({
  "set-text-content": Object.freeze({
    risk: "low",
    description: "Replace the content of one existing, unlocked text node.",
  }),
  "set-fill-color": Object.freeze({
    risk: "medium",
    description:
      "Replace the existing solid fill of one unlocked, non-group node.",
  }),
  "set-letter-spacing": Object.freeze({
    risk: "medium",
    description:
      "Set finite, bounded letter spacing on one existing, unlocked text node.",
  }),
  "create-logo-variant": Object.freeze({
    risk: "low",
    description:
      "Clone a non-empty artboard as a new logo variant without editing its source.",
  }),
}) satisfies Readonly<
  Record<DesignMateAction["type"], DesignMateMutationToolMetadata>
>;

/** Alias named for consumers that present metadata alongside action schemas. */
export const DESIGN_MATE_ACTION_METADATA = DESIGN_MATE_MUTATION_TOOLS;
