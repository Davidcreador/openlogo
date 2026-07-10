import {
  findContainerId,
  type DocumentStore,
  type LogoDocument,
} from "@openlogo/core";
import {
  isDesignMateProposalStale,
  type PreparedDesignMateProposal,
} from "@openlogo/design-mate";
import { documentToSvg, nodesToSvg } from "./export";
import { fontStore } from "./font-store";

export type DesignMateProposalPreview = {
  readonly kind: "nodes" | "variant";
  readonly before: {
    readonly dataUrl: string;
    readonly label: string;
  };
  readonly after: {
    readonly dataUrl: string;
    readonly label: string;
  };
};

export type ApplyPreparedDesignMateProposalResult =
  | { readonly status: "applied" }
  | { readonly status: "stale" }
  | { readonly status: "rejected" };

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function nodeTargetLabel(
  document: LogoDocument,
  nodeIds: readonly string[],
): string {
  if (nodeIds.length !== 1) {
    return `${nodeIds.length} changed objects`;
  }
  const name = document.nodes[nodeIds[0]!]?.name.trim();
  return name ? name : "Changed object";
}

const GEOMETRY_ACTION_TYPES = new Set([
  "translate-nodes",
  "scale-nodes",
  "rotate-nodes",
  "align-nodes",
  "distribute-nodes",
]);

function owningArtboardId(
  document: LogoDocument,
  nodeId: string,
): string | null {
  let currentId = nodeId;
  const seen = new Set<string>();
  while (!seen.has(currentId)) {
    seen.add(currentId);
    const containerId = findContainerId(document, currentId);
    if (!containerId) {
      return null;
    }
    if (document.artboards.some((artboard) => artboard.id === containerId)) {
      return containerId;
    }
    currentId = containerId;
  }
  return null;
}

/**
 * Builds detached export previews from the review-time and prepared documents.
 * Neither input is modified or installed into the live editor store.
 */
export function createDesignMateProposalPreview(
  baseDocument: LogoDocument,
  prepared: PreparedDesignMateProposal,
): DesignMateProposalPreview | null {
  try {
    if (
      isDesignMateProposalStale(prepared, baseDocument, {
        generation: prepared.identity.generation,
        revision: prepared.identity.revision,
      })
    ) {
      return null;
    }

    const variantActions = prepared.proposal.actions.filter(
      (action) => action.type === "create-logo-variant",
    );
    if (
      variantActions.length > 0 &&
      (variantActions.length !== 1 ||
        prepared.impact.createdArtboardIds.length !== 1 ||
        prepared.impact.changedNodeIds.length > 0)
    ) {
      // A two-frame comparison cannot accurately depict mixed or multi-board
      // proposals. Keep the textual impact summary instead of showing a
      // partial, potentially misleading preview.
      return null;
    }
    const variantAction = variantActions[0];
    if (variantAction) {
      const createdArtboardId = prepared.impact.createdArtboardIds[0];
      const sourceArtboard = baseDocument.artboards.find(
        (artboard) => artboard.id === variantAction.sourceArtboardId,
      );
      const createdArtboard = createdArtboardId
        ? prepared.previewDocument.artboards.find(
            (artboard) => artboard.id === createdArtboardId,
          )
        : undefined;
      if (
        !sourceArtboard ||
        !createdArtboard ||
        !sourceArtboard.nodeIds.every(
          (nodeId) => baseDocument.nodes[nodeId] !== undefined,
        ) ||
        !createdArtboard.nodeIds.every(
          (nodeId) => prepared.previewDocument.nodes[nodeId] !== undefined,
        )
      ) {
        return null;
      }

      return {
        kind: "variant",
        before: {
          dataUrl: svgDataUrl(documentToSvg(baseDocument, sourceArtboard)),
          label: `Before · ${sourceArtboard.name}`,
        },
        after: {
          dataUrl: svgDataUrl(
            documentToSvg(prepared.previewDocument, createdArtboard),
          ),
          label: `After · ${createdArtboard.name}`,
        },
      };
    }

    const nodeIds = [...new Set(prepared.impact.changedNodeIds)];
    if (
      nodeIds.length === 0 ||
      !nodeIds.every(
        (nodeId) =>
          baseDocument.nodes[nodeId] !== undefined &&
          prepared.previewDocument.nodes[nodeId] !== undefined,
      )
    ) {
      return null;
    }
    if (
      prepared.proposal.actions.some((action) =>
        GEOMETRY_ACTION_TYPES.has(action.type),
      )
    ) {
      const artboardIds = new Set(
        nodeIds.map((nodeId) => owningArtboardId(baseDocument, nodeId)),
      );
      if (artboardIds.size !== 1 || artboardIds.has(null)) {
        return null;
      }
      const artboardId = [...artboardIds][0]!;
      if (
        nodeIds.some(
          (nodeId) =>
            owningArtboardId(prepared.previewDocument, nodeId) !== artboardId,
        )
      ) {
        return null;
      }
      const beforeArtboard = baseDocument.artboards.find(
        (artboard) => artboard.id === artboardId,
      );
      const afterArtboard = prepared.previewDocument.artboards.find(
        (artboard) => artboard.id === artboardId,
      );
      if (!beforeArtboard || !afterArtboard) {
        return null;
      }
      return {
        kind: "nodes",
        before: {
          dataUrl: svgDataUrl(
            documentToSvg(baseDocument, beforeArtboard),
          ),
          label: `Before · ${beforeArtboard.name}`,
        },
        after: {
          dataUrl: svgDataUrl(
            documentToSvg(prepared.previewDocument, afterArtboard),
          ),
          label: `After · ${afterArtboard.name}`,
        },
      };
    }
    const beforeSvg = nodesToSvg(baseDocument, nodeIds);
    const afterSvg = nodesToSvg(prepared.previewDocument, nodeIds);
    if (!beforeSvg || !afterSvg) {
      return null;
    }

    return {
      kind: "nodes",
      before: {
        dataUrl: svgDataUrl(beforeSvg),
        label: `Before · ${nodeTargetLabel(baseDocument, nodeIds)}`,
      },
      after: {
        dataUrl: svgDataUrl(afterSvg),
        label: `After · ${nodeTargetLabel(prepared.previewDocument, nodeIds)}`,
      },
    };
  } catch {
    return null;
  }
}

/** Warm the final text faces after an approved family or weight change. */
export function ensureDesignMateProposalFonts(
  prepared: PreparedDesignMateProposal,
): void {
  if (
    !prepared.proposal.actions.some(
      (action) =>
        action.type === "set-font-family" ||
        action.type === "set-font-weight",
    )
  ) {
    return;
  }
  const seen = new Set<string>();
  for (const nodeId of prepared.impact.changedNodeIds) {
    const node = prepared.previewDocument.nodes[nodeId];
    if (node?.type !== "text") {
      continue;
    }
    const key = `${node.fontFamily}\u0000${node.fontWeight}\u0000${node.fontStyle ?? "normal"}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    void fontStore.ensure(
      node.fontFamily,
      node.fontWeight,
      node.fontStyle ?? "normal",
    );
  }
}

/**
 * Applies only a proposal prepared against the exact committed store head.
 * The batch command remains one DocumentStore history entry.
 */
export function applyPreparedDesignMateProposal(
  store: DocumentStore,
  prepared: PreparedDesignMateProposal,
): ApplyPreparedDesignMateProposalResult {
  const committedDocument = store.committedDocument;
  const generation = store.documentGeneration;
  const revision = store.committedRevision;

  if (
    isDesignMateProposalStale(prepared, committedDocument, {
      generation,
      revision,
    })
  ) {
    return { status: "stale" };
  }

  try {
    store.apply(prepared.command);
  } catch {
    return { status: "rejected" };
  }

  return store.documentGeneration === generation &&
    store.committedRevision === revision + 1 &&
    store.committedDocument !== committedDocument
    ? { status: "applied" }
    : { status: "rejected" };
}
