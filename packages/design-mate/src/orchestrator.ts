import type {
  DesignReview,
  LogoDocument,
  ReviewScope,
} from "@openlogo/core";
import { Effect } from "effect";
import { buildDesignContext, resolveDesignMateScope } from "./context";
import type {
  CollectedDesignMateReview,
  DesignMateProvider,
  DesignMateProviderError,
  DesignMateReviewEvent,
  DesignMateReviewRequest,
  DesignMateSelection,
  DesignMateStreamResult,
} from "./contracts";
import {
  buildDocumentIdentity,
  type BuildDocumentIdentityOptions,
} from "./identity";
import {
  heuristicDesignMateProvider,
  makeDesignMateProviderError,
} from "./provider";
import { structuredCloneAndDeepFreeze } from "./snapshot";
import { snapshotValidDesignReview } from "./validation";

export type PrepareDesignMateReviewOptions = BuildDocumentIdentityOptions & {
  readonly scope?: ReviewScope;
};

export type RunDesignMateReviewOptions = PrepareDesignMateReviewOptions & {
  readonly provider?: DesignMateProvider;
};

export function prepareDesignMateReviewRequest(
  document: LogoDocument,
  selection: DesignMateSelection,
  options: PrepareDesignMateReviewOptions,
): DesignMateReviewRequest {
  const normalizedSelection: DesignMateSelection = {
    selectedNodeIds: [...selection.selectedNodeIds],
    ...(selection.keyObjectId !== undefined
      ? { keyObjectId: selection.keyObjectId }
      : {}),
    ...(selection.activeGroupId !== undefined
      ? { activeGroupId: selection.activeGroupId }
      : {}),
  };
  const requestedScope = resolveDesignMateScope(
    normalizedSelection,
    options.scope,
  );
  const context = buildDesignContext(document, normalizedSelection, {
    scope: requestedScope,
  });
  const documentSnapshot = structuredCloneAndDeepFreeze(document);

  return {
    document: documentSnapshot,
    selection: normalizedSelection,
    scope: context.scope,
    identity: buildDocumentIdentity(document, options),
    context,
  };
}

function isProviderError(value: unknown): value is DesignMateProviderError {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<DesignMateProviderError>;
  return (
    candidate._tag === "DesignMateProviderError" &&
    (candidate.code === "provider-failed" ||
      candidate.code === "invalid-review") &&
    typeof candidate.providerId === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.retryable === "boolean"
  );
}

function normalizeProviderFailure(
  providerId: string,
  cause: unknown,
): DesignMateProviderError {
  if (isProviderError(cause)) {
    return cause;
  }
  return makeDesignMateProviderError(
    providerId,
    cause instanceof Error && cause.message.length > 0
      ? cause.message
      : "The Design Mate provider could not complete the review.",
  );
}

type ProviderOutcome =
  | { readonly ok: true; readonly review: DesignReview }
  | { readonly ok: false; readonly error: DesignMateProviderError };

async function resolveProviderReview(
  provider: DesignMateProvider,
  request: DesignMateReviewRequest,
): Promise<ProviderOutcome> {
  try {
    const reviewEffect = provider.review(request);
    return await Effect.runPromise(
      reviewEffect.pipe(
        Effect.match({
          onFailure: (error): ProviderOutcome => ({ ok: false, error }),
          onSuccess: (review): ProviderOutcome => ({ ok: true, review }),
        }),
      ),
    );
  } catch (cause) {
    return {
      ok: false,
      error: normalizeProviderFailure(provider.id, cause),
    };
  }
}

/**
 * Low-level event orchestrator for an already prepared request.
 *
 * Success order is always started → context → summary → finding* → completed.
 * Failure order is always started → context → failed.
 */
export async function* orchestrateDesignMateReview(
  request: DesignMateReviewRequest,
  provider: DesignMateProvider = heuristicDesignMateProvider,
): AsyncGenerator<DesignMateReviewEvent, DesignMateStreamResult, void> {
  yield {
    type: "started",
    providerId: provider.id,
    scope: request.scope,
    identity: request.identity,
  };
  yield { type: "context", context: request.context };

  const outcome = await resolveProviderReview(provider, request);
  if (!outcome.ok) {
    yield { type: "failed", error: outcome.error };
    return {
      status: "failed",
      scope: request.scope,
      context: request.context,
      identity: request.identity,
      error: outcome.error,
    };
  }

  const review = snapshotValidDesignReview(outcome.review);
  if (!review) {
    const error = makeDesignMateProviderError(
      provider.id,
      "The Design Mate provider returned an invalid review.",
      { code: "invalid-review" },
    );
    yield { type: "failed", error };
    return {
      status: "failed",
      scope: request.scope,
      context: request.context,
      identity: request.identity,
      error,
    };
  }

  yield { type: "summary", summary: review.summary };
  for (
    let index = 0;
    index < review.findings.length;
    index += 1
  ) {
    yield {
      type: "finding",
      index,
      total: review.findings.length,
      finding: review.findings[index]!,
    };
  }
  yield {
    type: "completed",
    findingCount: review.findings.length,
  };

  return {
    status: "completed",
    scope: request.scope,
    context: request.context,
    identity: request.identity,
    review,
  };
}

export async function* streamDesignMateReview(
  document: LogoDocument,
  selection: DesignMateSelection,
  options: RunDesignMateReviewOptions,
): AsyncGenerator<DesignMateReviewEvent, DesignMateStreamResult, void> {
  const request = prepareDesignMateReviewRequest(document, selection, options);
  return yield* orchestrateDesignMateReview(
    request,
    options.provider ?? heuristicDesignMateProvider,
  );
}

export const runDesignMateReview = streamDesignMateReview;

export async function collectDesignMateReview(
  document: LogoDocument,
  selection: DesignMateSelection,
  options: RunDesignMateReviewOptions,
): Promise<CollectedDesignMateReview> {
  const events: DesignMateReviewEvent[] = [];
  const stream = streamDesignMateReview(document, selection, options);

  while (true) {
    const next = await stream.next();
    if (next.done) {
      if (next.value.status === "failed") {
        throw next.value.error;
      }
      return {
        scope: next.value.scope,
        context: next.value.context,
        identity: next.value.identity,
        review: next.value.review,
        events,
      };
    }
    events.push(next.value);
  }
}
