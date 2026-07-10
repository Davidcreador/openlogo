import { analyzeLogoDocument } from "@openlogo/core";
import type {
  AnalyzeLogoOptions,
  DesignReview,
  LogoDocument,
} from "@openlogo/core";
import { Effect } from "effect";
import {
  DESIGN_MATE_CHAT_LIMITS,
  type DesignMateProvider,
  type DesignMateProviderError,
  type DesignMateProviderErrorCode,
  type DesignMateReviewRequest,
} from "./contracts";

const PROVIDER_ERROR_CODES = new Set<DesignMateProviderErrorCode>([
  "provider-failed",
  "invalid-review",
  "invalid-chat-response",
  "invalid-request",
  "rate-limited",
  "cancelled",
]);

function boundedNonEmptyText(
  value: string,
  maximumLength: number,
  fallback: string,
): string {
  const bounded = value.slice(0, maximumLength);
  return bounded.trim().length > 0 ? bounded : fallback;
}

export function isDesignMateProviderError(
  value: unknown,
): value is DesignMateProviderError {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 5 ||
      !keys.every(
        (key) =>
          typeof key === "string" &&
          ["_tag", "code", "providerId", "message", "retryable"].includes(key),
      )
    ) {
      return false;
    }
    const candidate = value as Partial<DesignMateProviderError>;
    return (
      candidate._tag === "DesignMateProviderError" &&
      typeof candidate.code === "string" &&
      PROVIDER_ERROR_CODES.has(candidate.code as DesignMateProviderErrorCode) &&
      typeof candidate.providerId === "string" &&
      candidate.providerId.trim().length > 0 &&
      candidate.providerId.length <= DESIGN_MATE_CHAT_LIMITS.providerIdLength &&
      typeof candidate.message === "string" &&
      candidate.message.trim().length > 0 &&
      candidate.message.length <= DESIGN_MATE_CHAT_LIMITS.errorMessageLength &&
      typeof candidate.retryable === "boolean"
    );
  } catch {
    return false;
  }
}

export type DesignMateProviderErrorOptions = {
  readonly code?: DesignMateProviderErrorCode;
  readonly retryable?: boolean;
};

export function makeDesignMateProviderError(
  providerId: string,
  message: string,
  options: DesignMateProviderErrorOptions = {},
): DesignMateProviderError {
  return Object.freeze({
    _tag: "DesignMateProviderError",
    code: options.code ?? "provider-failed",
    providerId: boundedNonEmptyText(
      providerId,
      DESIGN_MATE_CHAT_LIMITS.providerIdLength,
      "unknown-provider",
    ),
    message: boundedNonEmptyText(
      message,
      DESIGN_MATE_CHAT_LIMITS.errorMessageLength,
      "The Design Mate provider could not complete the request.",
    ),
    retryable: options.retryable ?? false,
  });
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "The Design Mate provider could not complete the review.";
}

type AnalyzeWithOptions = (
  document: LogoDocument,
  options?: AnalyzeLogoOptions,
) => DesignReview;

export function createHeuristicDesignMateProvider(): DesignMateProvider {
  const id = "heuristic";
  return {
    id,
    review: (request) =>
      Effect.try({
        try: () =>
          (analyzeLogoDocument as AnalyzeWithOptions)(request.document, {
            scope: request.scope,
            selectionIds: [...request.selection.selectedNodeIds],
          }),
        catch: (cause) =>
          makeDesignMateProviderError(id, failureMessage(cause)),
      }),
  };
}

export const heuristicDesignMateProvider =
  createHeuristicDesignMateProvider();

export type FakeDesignMateProvider = DesignMateProvider & {
  readonly requests: readonly DesignMateReviewRequest[];
};

export type FakeDesignMateProviderOptions =
  | {
      readonly id?: string;
      readonly review: DesignReview;
      readonly error?: never;
      readonly respond?: never;
    }
  | {
      readonly id?: string;
      readonly review?: never;
      readonly error: DesignMateProviderError;
      readonly respond?: never;
    }
  | {
      readonly id?: string;
      readonly review?: never;
      readonly error?: never;
      readonly respond: (
        request: DesignMateReviewRequest,
        callIndex: number,
      ) => Effect.Effect<DesignReview, DesignMateProviderError>;
    };

/**
 * Small deterministic provider for package and consumer tests. Requests are
 * retained by reference for assertions; the provider never mutates them.
 */
export function createFakeDesignMateProvider(
  options: FakeDesignMateProviderOptions,
): FakeDesignMateProvider {
  const id = options.id ?? "fake";
  const requests: DesignMateReviewRequest[] = [];

  return {
    id,
    requests,
    review: (request) => {
      requests.push(request);
      if (options.respond) {
        return options.respond(request, requests.length - 1);
      }
      if (options.error) {
        return Effect.fail(options.error);
      }
      return Effect.succeed(options.review);
    },
  };
}
