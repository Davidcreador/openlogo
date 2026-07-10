import {
  createInitialDocument,
  type DesignReview,
  type ReviewFinding,
} from "@openlogo/core";
import { describe, expect, it } from "vitest";
import {
  DESIGN_REVIEW_LIMITS,
  createFakeDesignMateProvider,
  isValidDesignReview,
  orchestrateDesignMateReview,
  prepareDesignMateReviewRequest,
  type DesignMateReviewEvent,
  type DesignMateStreamResult,
} from "./index";

function makeFinding(id = "finding.valid"): ReviewFinding {
  return {
    id,
    severity: "warning",
    category: "composition",
    kind: "objective",
    title: "Alignment needs review",
    detail: "The selected elements do not yet share a clear visual axis.",
    action: "Align the selected elements to a shared edge.",
    nodeIds: ["node-a", "node-b"],
    artboardId: "artboard-a",
    evidence: [
      { label: "Horizontal offset", value: 12, unit: "px" },
      { label: "Reference", value: "Left edge" },
    ],
    suggestedActions: [
      { id: "align-left", label: "Align the elements to the left." },
    ],
  };
}

function makeReview(...findings: unknown[]): unknown {
  return {
    summary: "The composition has a clear direction.",
    findings,
  };
}

function invalidReviewCases(): readonly {
  readonly name: string;
  readonly review: unknown;
}[] {
  const missingKind: Record<string, unknown> = { ...makeFinding() };
  delete missingKind.kind;

  return [
    {
      name: "a missing enriched finding field",
      review: makeReview(missingKind),
    },
    {
      name: "an unknown severity",
      review: makeReview({ ...makeFinding(), severity: "critical" }),
    },
    {
      name: "an unknown category",
      review: makeReview({ ...makeFinding(), category: "branding" }),
    },
    {
      name: "an unknown review kind",
      review: makeReview({ ...makeFinding(), kind: "subjective" }),
    },
    {
      name: "a non-finite number after an otherwise valid finding",
      review: makeReview(
        makeFinding("finding.first"),
        {
          ...makeFinding("finding.invalid-number"),
          evidence: [{ label: "Ratio", value: Number.POSITIVE_INFINITY }],
        },
      ),
    },
    {
      name: "a bigint scalar",
      review: makeReview({
        ...makeFinding(),
        evidence: [{ label: "Count", value: 1n }],
      }),
    },
    {
      name: "an uncloneable scalar",
      review: makeReview({
        ...makeFinding(),
        evidence: [{ label: "Callback", value: () => 1 }],
      }),
    },
    {
      name: "duplicate finding ids",
      review: makeReview(makeFinding("duplicate"), makeFinding("duplicate")),
    },
    {
      name: "duplicate node ids",
      review: makeReview({
        ...makeFinding(),
        nodeIds: ["node-a", "node-a"],
      }),
    },
    {
      name: "duplicate suggested-action ids",
      review: makeReview({
        ...makeFinding(),
        suggestedActions: [
          { id: "same-action", label: "First action" },
          { id: "same-action", label: "Second action" },
        ],
      }),
    },
    {
      name: "too many findings",
      review: makeReview(
        ...Array.from(
          { length: DESIGN_REVIEW_LIMITS.findings + 1 },
          (_, index) => makeFinding(`finding-${index}`),
        ),
      ),
    },
    {
      name: "too many node references",
      review: makeReview({
        ...makeFinding(),
        nodeIds: Array.from(
          { length: DESIGN_REVIEW_LIMITS.nodeIds + 1 },
          (_, index) => `node-${index}`,
        ),
      }),
    },
    {
      name: "too many suggested actions",
      review: makeReview({
        ...makeFinding(),
        suggestedActions: Array.from(
          { length: DESIGN_REVIEW_LIMITS.suggestedActions + 1 },
          (_, index) => ({ id: `action-${index}`, label: "Apply action" }),
        ),
      }),
    },
    {
      name: "an overlong summary",
      review: {
        summary: "s".repeat(DESIGN_REVIEW_LIMITS.summaryLength + 1),
        findings: [makeFinding()],
      },
    },
    {
      name: "an overlong detail",
      review: makeReview({
        ...makeFinding(),
        detail: "d".repeat(DESIGN_REVIEW_LIMITS.detailLength + 1),
      }),
    },
    {
      name: "an unknown finding field",
      review: makeReview({ ...makeFinding(), confidence: 0.9 }),
    },
  ];
}

async function drain(
  stream: AsyncGenerator<
    DesignMateReviewEvent,
    DesignMateStreamResult,
    void
  >,
): Promise<{
  readonly events: DesignMateReviewEvent[];
  readonly result: DesignMateStreamResult;
}> {
  const events: DesignMateReviewEvent[] = [];
  while (true) {
    const next = await stream.next();
    if (next.done) {
      return { events, result: next.value };
    }
    events.push(next.value);
  }
}

describe("provider review validation", () => {
  it("accepts the full shape at the documented text and list boundaries", () => {
    const boundaryFinding: ReviewFinding = {
      ...makeFinding("i".repeat(DESIGN_REVIEW_LIMITS.findingIdLength)),
      title: "t".repeat(DESIGN_REVIEW_LIMITS.titleLength),
      detail: "d".repeat(DESIGN_REVIEW_LIMITS.detailLength),
      action: "a".repeat(DESIGN_REVIEW_LIMITS.actionLength),
      nodeIds: Array.from(
        { length: DESIGN_REVIEW_LIMITS.nodeIds },
        (_, index) => `node-${index}`,
      ),
      artboardId: "b".repeat(DESIGN_REVIEW_LIMITS.referenceIdLength),
      evidence: Array.from(
        { length: DESIGN_REVIEW_LIMITS.evidence },
        () => ({
          label: "l".repeat(DESIGN_REVIEW_LIMITS.evidenceLabelLength),
          value: "v".repeat(
            DESIGN_REVIEW_LIMITS.evidenceStringValueLength,
          ),
          unit: "u".repeat(DESIGN_REVIEW_LIMITS.evidenceUnitLength),
        }),
      ),
      suggestedActions: Array.from(
        { length: DESIGN_REVIEW_LIMITS.suggestedActions },
        (_, index) => ({
          id: `action-${index}`,
          label: "l".repeat(
            DESIGN_REVIEW_LIMITS.suggestedActionLabelLength,
          ),
        }),
      ),
    };
    const review: DesignReview = {
      summary: "s".repeat(DESIGN_REVIEW_LIMITS.summaryLength),
      findings: [boundaryFinding],
    };
    const maximumFindings: DesignReview = {
      summary: "Bounded findings",
      findings: Array.from(
        { length: DESIGN_REVIEW_LIMITS.findings },
        (_, index) => makeFinding(`finding-${index}`),
      ),
    };

    expect(isValidDesignReview(review)).toBe(true);
    expect(isValidDesignReview(maximumFindings)).toBe(true);
  });

  it.each(invalidReviewCases())(
    "emits only started, context, and invalid-review failed for $name",
    async ({ review }) => {
      const document = createInitialDocument();
      const provider = createFakeDesignMateProvider({
        id: "invalid-output-provider",
        review: review as DesignReview,
      });
      const request = prepareDesignMateReviewRequest(
        document,
        { selectedNodeIds: [] },
        { generation: 0, revision: 0 },
      );

      const { events, result } = await drain(
        orchestrateDesignMateReview(request, provider),
      );

      expect(events.map((event) => event.type)).toEqual([
        "started",
        "context",
        "failed",
      ]);
      const failed = events[2];
      expect(failed?.type).toBe("failed");
      if (!failed || failed.type !== "failed") {
        throw new Error("Expected an invalid-review failure event.");
      }
      expect(failed.error).toMatchObject({
        _tag: "DesignMateProviderError",
        code: "invalid-review",
        providerId: "invalid-output-provider",
        retryable: false,
      });
      expect(events.some((event) => event.type === "summary")).toBe(false);
      expect(result).toMatchObject({
        status: "failed",
        error: { code: "invalid-review" },
      });
    },
  );
});
