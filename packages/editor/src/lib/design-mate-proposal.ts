import type { DocumentStore, LogoDocument } from "@openlogo/core";
import {
  isDesignMateProposalStale,
  type PreparedDesignMateProposal,
} from "@openlogo/design-mate";
import { documentToSvg, nodesToSvg } from "./export";

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
