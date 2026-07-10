import { analyzeLogoDocument } from "@openlogo/core";
import type {
  AnalyzeLogoOptions,
  DesignReview,
  LogoDocument,
} from "@openlogo/core";
import { Effect } from "effect";
import type {
  DesignMateProvider,
  DesignMateProviderError,
  DesignMateProviderErrorCode,
  DesignMateReviewRequest,
} from "./contracts";

export type DesignMateProviderErrorOptions = {
  readonly code?: DesignMateProviderErrorCode;
  readonly retryable?: boolean;
};

export function makeDesignMateProviderError(
  providerId: string,
  message: string,
  options: DesignMateProviderErrorOptions = {},
): DesignMateProviderError {
  return {
    _tag: "DesignMateProviderError",
    code: options.code ?? "provider-failed",
    providerId,
    message,
    retryable: options.retryable ?? false,
  };
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
