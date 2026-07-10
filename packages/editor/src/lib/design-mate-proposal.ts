import {
  findContainerId,
  paintBounds,
  type Bounds,
  type DocumentStore,
  type LogoDocument,
} from "@openlogo/core";
import {
  isDesignMateProposalStale,
  type PreparedDesignMateProposal,
} from "@openlogo/design-mate";
import { documentToSvg, nodesToSvg } from "./export";
import { catalogEntry } from "./font-catalog";
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

const DESIGN_MATE_PREVIEW_SVG_BYTES = 256 * 1_024;

function svgDataUrl(svg: string): string | null {
  if (
    new TextEncoder().encode(svg).byteLength >
    DESIGN_MATE_PREVIEW_SVG_BYTES
  ) {
    return null;
  }
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

function commonNodePreviewBounds(
  before: LogoDocument,
  after: LogoDocument,
  nodeIds: readonly string[],
): Bounds | null {
  const bounds = nodeIds.flatMap((nodeId) => {
    const beforeBounds = paintBounds(before, nodeId);
    const afterBounds = paintBounds(after, nodeId);
    return [
      ...(beforeBounds ? [beforeBounds] : []),
      ...(afterBounds ? [afterBounds] : []),
    ];
  });
  if (bounds.length === 0) {
    return null;
  }
  const minX = Math.min(...bounds.map((item) => item.x));
  const minY = Math.min(...bounds.map((item) => item.y));
  const maxX = Math.max(...bounds.map((item) => item.x + item.width));
  const maxY = Math.max(...bounds.map((item) => item.y + item.height));
  const width = maxX - minX;
  const height = maxY - minY;
  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  const padding = Math.max(2, Math.max(width, height) * 0.08);
  return {
    x: minX - padding,
    y: minY - padding,
    width: width + padding * 2,
    height: height + padding * 2,
  };
}

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

      const beforeUrl = svgDataUrl(
        documentToSvg(baseDocument, sourceArtboard),
      );
      const afterUrl = svgDataUrl(
        documentToSvg(prepared.previewDocument, createdArtboard),
      );
      if (!beforeUrl || !afterUrl) {
        return null;
      }
      return {
        kind: "variant",
        before: {
          dataUrl: beforeUrl,
          label: `Before · ${sourceArtboard.name}`,
        },
        after: {
          dataUrl: afterUrl,
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
      prepared.proposal.actions.some(
        (action) =>
          action.type === "set-font-family" ||
          action.type === "set-font-weight",
      )
    ) {
      // Data-URL SVG images cannot reliably share the editor's FontFace
      // registry. Textual impact is safer than a fallback-font comparison.
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
    }
    const frame = commonNodePreviewBounds(
      baseDocument,
      prepared.previewDocument,
      nodeIds,
    );
    if (!frame) {
      return null;
    }
    const beforeSvg = nodesToSvg(baseDocument, nodeIds, frame);
    const afterSvg = nodesToSvg(
      prepared.previewDocument,
      nodeIds,
      frame,
    );
    if (!beforeSvg || !afterSvg) {
      return null;
    }
    const beforeUrl = svgDataUrl(beforeSvg);
    const afterUrl = svgDataUrl(afterSvg);
    if (!beforeUrl || !afterUrl) {
      return null;
    }

    return {
      kind: "nodes",
      before: {
        dataUrl: beforeUrl,
        label: `Before · ${nodeTargetLabel(baseDocument, nodeIds)}`,
      },
      after: {
        dataUrl: afterUrl,
        label: `After · ${nodeTargetLabel(prepared.previewDocument, nodeIds)}`,
      },
    };
  } catch {
    return null;
  }
}

/** Load exact final text faces before an approved family or weight change. */
export async function prepareDesignMateProposalFonts(
  prepared: PreparedDesignMateProposal,
): Promise<boolean> {
  if (
    !prepared.proposal.actions.some(
      (action) =>
        action.type === "set-font-family" ||
        action.type === "set-font-weight",
    )
  ) {
    return true;
  }
  const seen = new Set<string>();
  const targetIds = prepared.proposal.actions.flatMap((action) =>
    action.type === "set-font-family" ||
    action.type === "set-font-weight"
      ? [action.nodeId]
      : [],
  );
  for (const nodeId of targetIds) {
    const node = prepared.previewDocument.nodes[nodeId];
    if (node?.type !== "text") {
      return false;
    }
    const family = catalogEntry(node.fontFamily);
    const style = node.fontStyle ?? "normal";
    if (
      !family ||
      !family.weights.includes(node.fontWeight) ||
      !family.styles.includes(style)
    ) {
      return false;
    }
    const key = `${family.name}\u0000${node.fontWeight}\u0000${style}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const bytes = await fontStore.ensure(
      family.name,
      node.fontWeight,
      style,
    );
    if (!bytes) {
      return false;
    }
  }
  return true;
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
