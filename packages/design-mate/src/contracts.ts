import type {
  Command,
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

export type DesignMateRisk = "low" | "medium" | "high";

export type SetTextContentDesignMateAction = {
  readonly type: "set-text-content";
  readonly nodeId: string;
  readonly content: string;
};

export type SetFillColorDesignMateAction = {
  readonly type: "set-fill-color";
  readonly nodeId: string;
  /** Opaque solid color; proposal validation currently accepts hex colors. */
  readonly color: string;
};

export type SetLetterSpacingDesignMateAction = {
  readonly type: "set-letter-spacing";
  readonly nodeId: string;
  readonly letterSpacing: number;
};

export type CreateLogoVariantDesignMateAction = {
  readonly type: "create-logo-variant";
  readonly sourceArtboardId: string;
  readonly purpose: LogoVariant;
};

/** Closed mutation surface accepted from a future model-backed provider. */
export type DesignMateAction =
  | SetTextContentDesignMateAction
  | SetFillColorDesignMateAction
  | SetLetterSpacingDesignMateAction
  | CreateLogoVariantDesignMateAction;

export type DesignMateProposal = {
  readonly id: string;
  readonly label: string;
  readonly rationale?: string;
  readonly risk: DesignMateRisk;
  readonly sourceFindingIds?: readonly string[];
  readonly actions: readonly DesignMateAction[];
};

export type DesignMateMutationToolMetadata = {
  readonly risk: DesignMateRisk;
  readonly description: string;
};

export type DesignMateProposalImpact = {
  readonly changedNodeIds: readonly string[];
  readonly createdArtboardIds: readonly string[];
  readonly summaries: readonly string[];
};

export type DesignMateBatchCommand = Extract<Command, { type: "batch" }>;

export type PreparedDesignMateProposal = {
  readonly proposal: DesignMateProposal;
  readonly identity: DocumentIdentity;
  /** A single history entry; its child commands are applied in order. */
  readonly command: DesignMateBatchCommand;
  readonly previewDocument: LogoDocument;
  readonly impact: DesignMateProposalImpact;
};

export type DesignMateProposalErrorCode =
  | "invalid-proposal"
  | "precondition-failed"
  | "no-op"
  | "preparation-failed";

export type DesignMateProposalError = {
  readonly _tag: "DesignMateProposalError";
  readonly code: DesignMateProposalErrorCode;
  /** Bounded, non-provider-authored message suitable for display or logs. */
  readonly message: string;
  readonly actionIndex?: number;
};

export type PrepareDesignMateProposalResult =
  | {
      readonly ok: true;
      readonly prepared: PreparedDesignMateProposal;
    }
  | {
      readonly ok: false;
      readonly error: DesignMateProposalError;
    };

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
  | "invalid-review"
  | "invalid-chat-response"
  | "invalid-request"
  | "rate-limited"
  | "cancelled";

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

/**
 * Hard limits shared by chat preparation, untrusted wire validation, provider
 * output validation, and the SSE transport. Aliases are intentionally avoided:
 * every limit has one unambiguous unit in its name.
 */
export const DESIGN_MATE_CHAT_LIMITS = Object.freeze({
  chatIdLength: 256,
  referenceIdLength: 2_048,
  providerIdLength: 128,
  fingerprintLength: 128,
  timestampLength: 32,
  historyMessages: 24,
  userTextLength: 4_000,
  assistantTextLength: 16_000,
  deltaTextLength: 4_000,
  deltas: 512,
  attachments: 3,
  attachmentBytes: 700 * 1_024,
  attachmentMinimumDimension: 32,
  attachmentMaximumDimension: 1_024,
  attachmentPixels: 1_000_000,
  attachmentLabelLength: 160,
  selectionIds: 512,
  contextStringLength: 4_000,
  contextSerializedBytes: 128 * 1_024,
  sseFrameBytes: 64 * 1_024,
  errorMessageLength: 1_000,
} as const);

export type DesignMateChatRole = "user" | "assistant";

export type DesignMateChatMessage = {
  readonly id: string;
  readonly role: DesignMateChatRole;
  readonly text: string;
  readonly createdAt: string;
};

export type DesignMateVisualAttachmentKind =
  | "selection"
  | "active-artboard"
  | "document-overview";

export type DesignMateVisualAttachment = {
  readonly id: string;
  readonly kind: DesignMateVisualAttachmentKind;
  readonly mimeType: "image/png";
  /** Raw base64 payload without a data-URL prefix. */
  readonly dataBase64: string;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly identity: DocumentIdentity;
  readonly label?: string;
};

export type DesignMateChatTurnInput = {
  readonly conversationId: string;
  readonly turnId: string;
  readonly assistantMessageId: string;
  readonly history: readonly DesignMateChatMessage[];
  readonly userMessage: DesignMateChatMessage;
  readonly attachments?: readonly DesignMateVisualAttachment[];
};

/** Shorter alias for callers that model one chat submission as an input. */
export type DesignMateChatInput = DesignMateChatTurnInput;

export type DesignMateChatTurnRequest = {
  /** Detached, deeply frozen snapshot. It must never cross a remote boundary. */
  readonly document: LogoDocument;
  readonly conversationId: string;
  readonly turnId: string;
  readonly assistantMessageId: string;
  readonly identity: DocumentIdentity;
  readonly context: DesignContext;
  readonly selection: DesignMateSelection;
  readonly scope: ReviewScope;
  readonly history: readonly DesignMateChatMessage[];
  readonly userMessage: DesignMateChatMessage;
  readonly attachments: readonly DesignMateVisualAttachment[];
};

/**
 * Provider-neutral remote request. `document?: never` makes accidental
 * forwarding a type error while the runtime validator rejects the key even
 * when its value is undefined.
 */
export type DesignMateChatWireRequest = {
  readonly conversationId: string;
  readonly turnId: string;
  readonly assistantMessageId: string;
  readonly identity: DocumentIdentity;
  readonly context: DesignContext;
  readonly selection: DesignMateSelection;
  readonly scope: ReviewScope;
  readonly history: readonly DesignMateChatMessage[];
  readonly userMessage: DesignMateChatMessage;
  readonly attachments: readonly DesignMateVisualAttachment[];
  readonly document?: never;
};

export type DesignMateChatProviderChunk = {
  readonly type: "text-delta";
  readonly delta: string;
};

export interface DesignMateChatProvider {
  readonly id: string;
  stream(
    request: DesignMateChatTurnRequest,
    signal?: AbortSignal,
  ): AsyncIterable<DesignMateChatProviderChunk>;
}

export type DesignMateChatPromptMessage = {
  readonly role: DesignMateChatRole;
  readonly text: string;
};

export type DesignMateChatPromptImage = {
  readonly id: string;
  readonly role: "user";
  readonly kind: DesignMateVisualAttachmentKind;
  readonly mimeType: "image/png";
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly label?: string;
};

export type DesignMateChatPrompt = {
  readonly system: string;
  readonly messages: readonly DesignMateChatPromptMessage[];
  readonly images: readonly DesignMateChatPromptImage[];
};

export type DesignMateChatStartedEvent = {
  readonly type: "started";
  readonly providerId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly scope: ReviewScope;
  readonly identity: DocumentIdentity;
};

export type DesignMateChatContextEvent = {
  readonly type: "context";
  readonly context: DesignContext;
};

export type DesignMateChatMessageStartEvent = {
  readonly type: "message-start";
  readonly messageId: string;
  readonly role: "assistant";
  readonly createdAt: string;
};

export type DesignMateChatTextDeltaEvent = {
  readonly type: "text-delta";
  readonly messageId: string;
  readonly index: number;
  readonly delta: string;
};

export type DesignMateChatMessageEndEvent = {
  readonly type: "message-end";
  readonly message: DesignMateChatMessage;
};

export type DesignMateChatCompletedEvent = {
  readonly type: "completed";
  readonly message: DesignMateChatMessage;
};

export type DesignMateChatFailedEvent = {
  readonly type: "failed";
  readonly error: DesignMateProviderError;
};

export type DesignMateChatCancelledEvent = {
  readonly type: "cancelled";
  readonly error: DesignMateProviderError;
};

export type DesignMateChatEvent =
  | DesignMateChatStartedEvent
  | DesignMateChatContextEvent
  | DesignMateChatMessageStartEvent
  | DesignMateChatTextDeltaEvent
  | DesignMateChatMessageEndEvent
  | DesignMateChatCompletedEvent
  | DesignMateChatFailedEvent
  | DesignMateChatCancelledEvent;

type DesignMateChatResultBase = {
  readonly conversationId: string;
  readonly turnId: string;
  readonly scope: ReviewScope;
  readonly context: DesignContext;
  readonly identity: DocumentIdentity;
};

export type DesignMateChatResult =
  | (DesignMateChatResultBase & {
      readonly status: "completed";
      readonly message: DesignMateChatMessage;
    })
  | (DesignMateChatResultBase & {
      readonly status: "failed";
      readonly error: DesignMateProviderError;
    })
  | (DesignMateChatResultBase & {
      readonly status: "cancelled";
      readonly error: DesignMateProviderError;
    });

export type CollectedDesignMateChat = DesignMateChatResult & {
  readonly events: readonly DesignMateChatEvent[];
};

export type DesignMateChatTransportEvent =
  | DesignMateChatProviderChunk
  | {
      readonly type: "completed";
    }
  | {
      readonly type: "failed";
      readonly error: DesignMateProviderError;
    };

export type DesignMateChatSseEvent = DesignMateChatTransportEvent;
export type DesignMateChatSSEEvent = DesignMateChatTransportEvent;
