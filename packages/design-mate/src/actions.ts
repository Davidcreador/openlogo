import type {
  DesignMateAction,
  DesignMateMutationToolMetadata,
  DesignMateRisk,
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
  "translate-nodes": Object.freeze({
    risk: "medium",
    description:
      "Move visible, unlocked selection units on one artboard by a bounded pixel delta.",
  }),
  "scale-nodes": Object.freeze({
    risk: "medium",
    description:
      "Resize visible, unlocked selection units around their current centre with bounded positive scale factors.",
  }),
  "rotate-nodes": Object.freeze({
    risk: "medium",
    description:
      "Rotate visible, unlocked selection units around their current centre by a bounded relative angle.",
  }),
  "align-nodes": Object.freeze({
    risk: "medium",
    description:
      "Align visible, unlocked units on one artboard to their selection, artboard, or an explicit key object.",
  }),
  "distribute-nodes": Object.freeze({
    risk: "medium",
    description:
      "Distribute the gaps between at least three visible, unlocked units on one artboard.",
  }),
  "set-font-family": Object.freeze({
    risk: "medium",
    description:
      "Set a bounded font-family name on one existing, unlocked text node.",
  }),
  "set-font-size": Object.freeze({
    risk: "medium",
    description:
      "Set a bounded font size on one existing, unlocked text node.",
  }),
  "set-font-weight": Object.freeze({
    risk: "medium",
    description:
      "Set a bounded numeric font weight on one existing, unlocked text node.",
  }),
  "set-opacity": Object.freeze({
    risk: "medium",
    description:
      "Set opacity from zero to one on one existing, visible, unlocked node.",
  }),
  "set-stroke-color": Object.freeze({
    risk: "medium",
    description:
      "Replace the solid color of an existing non-gradient stroke on one unlocked leaf node.",
  }),
  "set-stroke-width": Object.freeze({
    risk: "medium",
    description:
      "Set the bounded width of an existing stroke on one unlocked leaf node.",
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

const RISK_PRIORITY: Readonly<Record<DesignMateRisk, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** Highest registry-owned risk for a validated action list. */
export function designMateRiskForActions(
  actions: readonly DesignMateAction[],
): DesignMateRisk {
  return actions.reduce<DesignMateRisk>((highest, action) => {
    const risk = DESIGN_MATE_MUTATION_TOOLS[action.type].risk;
    return RISK_PRIORITY[risk] > RISK_PRIORITY[highest] ? risk : highest;
  }, "low");
}
