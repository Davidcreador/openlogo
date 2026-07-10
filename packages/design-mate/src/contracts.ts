import type {
  DesignBrief,
  DesignReview,
  LogoDocument,
  LogoVariant,
  NodeType,
  ReviewFinding,
  ReviewScope,
} from "@openlogo/core";
import type { Effect } from "effect";
import type { DocumentIdentity } from "./identity";

export type DesignMateSelection = {
  readonly selectedNodeIds: readonly string[];
  readonly keyObjectId?: string;
  readonly activeGroupId?: string;
};

export type DesignContextBounds = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type DesignContextSelectionFrame = {
  readonly bounds: DesignContextBounds;
  readonly rotation: number;
};

export type DesignContextArtboard = {
  readonly id: string;
  readonly name: string;
  readonly purpose: LogoVariant;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly background: string;
  readonly topLevelNodeCount: number;
  readonly leafNodeCount: number;
};

export type DesignContextVariant = {
  readonly id: string;
  readonly name: string;
  readonly purpose: LogoVariant;
  readonly width: number;
  readonly height: number;
  readonly background: string;
  readonly topLevelNodeCount: number;
};

export type DesignContextPaint = {
  readonly type: "solid" | "linear-gradient" | "radial-gradient";
  readonly colors: readonly string[];
  readonly colorsTruncated: boolean;
};

export type DesignContextTextDetails = {
  readonly content: string;
  readonly contentTruncated: boolean;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly fontStyle: "normal" | "italic";
  readonly letterSpacing: number;
  readonly lineHeight: number;
  readonly align: "left" | "center" | "right";
  readonly onPath: boolean;
};

export type DesignContextPathDetails = {
  readonly fillRule: "nonzero" | "evenodd";
  readonly hasEditableGeometry: boolean;
  readonly subpathCount: number;
};

export type DesignContextSelectedNodeArtboard = {
  /** Reference ids are preserved verbatim and are never text-truncated. */
  readonly id: string;
  readonly name: string;
  readonly nameTruncated: boolean;
  readonly purpose: LogoVariant;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly background: string;
};

export type DesignContextSelectedNodeBase = {
  readonly id: string;
  readonly name: string;
  readonly nameTruncated: boolean;
  /** Geometry bounds in coordinates local to the owning artboard. */
  readonly bounds: DesignContextBounds | null;
  /** Geometry bounds translated onto the shared multi-artboard canvas. */
  readonly worldBounds: DesignContextBounds | null;
  /** Null only for an inconsistent, unreachable document node. */
  readonly artboard: DesignContextSelectedNodeArtboard | null;
  readonly opacity: number;
  readonly visible: boolean;
  readonly locked: boolean;
};

export type DesignContextSelectedLeafNode =
  DesignContextSelectedNodeBase & {
    readonly type: Exclude<NodeType, "group">;
    readonly rotation: number;
    readonly fill: DesignContextPaint;
    readonly stroke?: {
      readonly width: number;
      readonly align: "center" | "inside" | "outside";
      readonly paint: DesignContextPaint;
    };
    readonly text?: DesignContextTextDetails;
    readonly path?: DesignContextPathDetails;
    readonly cornerRadius?: number;
  };

export type DesignContextSelectedGroupNode =
  DesignContextSelectedNodeBase & {
    readonly type: "group";
    /** Group rotation and paint fields are unused placeholders in LogoDocument. */
    readonly rotation: null;
    readonly childCount: number;
    readonly clippingMaskId?: string;
  };

export type DesignContextSelectedNode =
  | DesignContextSelectedLeafNode
  | DesignContextSelectedGroupNode;

export type DesignContextFontFamily = {
  readonly family: string;
  readonly textNodeCount: number;
};

export type DesignContextTypeStyle = {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly fontStyle: "normal" | "italic";
  readonly letterSpacing: number;
  readonly lineHeight: number;
  readonly textNodeCount: number;
};

export type DesignContextTypography = {
  readonly textNodeCount: number;
  readonly fontFamilies: readonly DesignContextFontFamily[];
  readonly styles: readonly DesignContextTypeStyle[];
};

export type DesignContextMetrics = {
  readonly artboardCount: number;
  readonly nodeCount: number;
  readonly leafNodeCount: number;
  readonly groupNodeCount: number;
  readonly textNodeCount: number;
  readonly visibleNodeCount: number;
  readonly hiddenNodeCount: number;
  readonly lockedNodeCount: number;
  readonly paletteCount: number;
  readonly paletteColorCount: number;
  readonly activeArtboardLeafNodeCount: number;
  readonly selectedNodeCount: number;
  readonly scopeLeafNodeCount: number;
};

export type DesignContextTruncation = {
  readonly documentText: boolean;
  readonly designBrief: boolean;
  readonly activeArtboard: boolean;
  readonly variants: boolean;
  readonly paletteColors: boolean;
  readonly typographyFamilies: boolean;
  readonly typographyStyles: boolean;
  readonly selectedNodes: boolean;
  readonly selectedNodeText: boolean;
};

/**
 * Bounded, JSON-safe projection of a committed Logo Document. It deliberately
 * contains summaries rather than the document's raw node table.
 */
export type DesignContext = {
  readonly scope: ReviewScope;
  readonly document: {
    readonly id: string;
    readonly name: string;
    readonly schemaVersion: number;
  };
  readonly designBrief: DesignBrief | null;
  readonly activeArtboard: DesignContextArtboard;
  readonly variants: readonly DesignContextVariant[];
  readonly paletteColors: readonly string[];
  readonly typography: DesignContextTypography;
  readonly metrics: DesignContextMetrics;
  readonly selection: {
    readonly selectedNodeCount: number;
    readonly keyObjectId?: string;
    readonly activeGroupId?: string;
  };
  readonly selectedNodes: readonly DesignContextSelectedNode[];
  readonly selectionFrame: DesignContextSelectionFrame | null;
  readonly truncation: DesignContextTruncation;
};

export type BuildDesignContextOptions = {
  readonly scope?: ReviewScope;
};

/**
 * Fully prepared request passed to a provider. `document` keeps the existing
 * LogoDocument API for local heuristics, but at runtime it is a detached,
 * deeply frozen structured-clone snapshot — never the editor's live committed
 * object. Providers that leave the process should serialize `identity`,
 * `context`, `selection`, and `scope` rather than forwarding that snapshot.
 */
export type DesignMateReviewRequest = {
  readonly document: LogoDocument;
  readonly selection: DesignMateSelection;
  readonly scope: ReviewScope;
  readonly identity: DocumentIdentity;
  readonly context: DesignContext;
};

export type DesignMateProviderErrorCode =
  | "provider-failed"
  | "invalid-review";

export type DesignMateProviderError = {
  readonly _tag: "DesignMateProviderError";
  readonly code: DesignMateProviderErrorCode;
  readonly providerId: string;
  readonly message: string;
  readonly retryable: boolean;
};

export interface DesignMateProvider {
  readonly id: string;
  review(
    request: DesignMateReviewRequest,
  ): Effect.Effect<DesignReview, DesignMateProviderError>;
}

export type DesignMateStartedEvent = {
  readonly type: "started";
  readonly providerId: string;
  readonly scope: ReviewScope;
  readonly identity: DocumentIdentity;
};

export type DesignMateContextEvent = {
  readonly type: "context";
  readonly context: DesignContext;
};

export type DesignMateSummaryEvent = {
  readonly type: "summary";
  readonly summary: string;
};

export type DesignMateFindingEvent = {
  readonly type: "finding";
  readonly index: number;
  readonly total: number;
  readonly finding: ReviewFinding;
};

export type DesignMateCompletedEvent = {
  readonly type: "completed";
  readonly findingCount: number;
};

export type DesignMateFailedEvent = {
  readonly type: "failed";
  readonly error: DesignMateProviderError;
};

export type DesignMateReviewEvent =
  | DesignMateStartedEvent
  | DesignMateContextEvent
  | DesignMateSummaryEvent
  | DesignMateFindingEvent
  | DesignMateCompletedEvent
  | DesignMateFailedEvent;

export type DesignMateEvent = DesignMateReviewEvent;

export type DesignMateStreamResult =
  | {
      readonly status: "completed";
      readonly scope: ReviewScope;
      readonly context: DesignContext;
      readonly identity: DocumentIdentity;
      readonly review: DesignReview;
    }
  | {
      readonly status: "failed";
      readonly scope: ReviewScope;
      readonly context: DesignContext;
      readonly identity: DocumentIdentity;
      readonly error: DesignMateProviderError;
    };

export type CollectedDesignMateReview = {
  readonly scope: ReviewScope;
  readonly context: DesignContext;
  readonly identity: DocumentIdentity;
  readonly review: DesignReview;
  readonly events: readonly DesignMateReviewEvent[];
};
