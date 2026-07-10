import { analyzeLogoDocument, createInitialDocument } from "@openlogo/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  orchestrateDesignMateReview,
  prepareDesignMateReviewRequest,
  type DesignMateProvider,
} from "./index";

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeepFrozen(Reflect.get(value, key), seen);
  }
}

describe("provider document boundary", () => {
  it("provides a detached, deeply frozen structured-clone snapshot", async () => {
    const document = createInitialDocument();
    const selectedNodeId = document.artboards[0]!.nodeIds[0]!;
    const original = structuredClone(document);
    const request = prepareDesignMateReviewRequest(
      document,
      { selectedNodeIds: [selectedNodeId] },
      { scope: "selection", generation: 3, revision: 8 },
    );

    expect(request.document).toEqual(document);
    expect(request.document).not.toBe(document);
    expect(request.document.artboards).not.toBe(document.artboards);
    expect(request.document.artboards[0]).not.toBe(document.artboards[0]);
    expect(request.document.artboards[0]!.nodeIds).not.toBe(
      document.artboards[0]!.nodeIds,
    );
    expect(request.document.nodes).not.toBe(document.nodes);
    expect(request.document.nodes[selectedNodeId]).not.toBe(
      document.nodes[selectedNodeId],
    );
    expect(request.document.nodes[selectedNodeId]!.fill).not.toBe(
      document.nodes[selectedNodeId]!.fill,
    );
    expect(request.document.palettes[0]!.colors).not.toBe(
      document.palettes[0]!.colors,
    );
    expectDeepFrozen(request.document);

    const mutationErrors: unknown[] = [];
    let receivedDocument: unknown;
    const provider: DesignMateProvider = {
      id: "mutation-attempt",
      review: (received) =>
        Effect.sync(() => {
          receivedDocument = received.document;
          try {
            received.document.name = "Provider mutation";
          } catch (error) {
            mutationErrors.push(error);
          }
          try {
            received.document.nodes[selectedNodeId]!.x = -999;
          } catch (error) {
            mutationErrors.push(error);
          }
          try {
            received.document.artboards[0]!.nodeIds.push("injected-node");
          } catch (error) {
            mutationErrors.push(error);
          }
          return analyzeLogoDocument(received.document, {
            scope: received.scope,
            selectionIds: received.selection.selectedNodeIds,
          });
        }),
    };

    const events = [];
    for await (const event of orchestrateDesignMateReview(request, provider)) {
      events.push(event);
    }

    expect(receivedDocument).toBe(request.document);
    expect(mutationErrors).toHaveLength(3);
    expect(events.at(-1)?.type).toBe("completed");
    expect(document).toEqual(original);
    expect(request.document).toEqual(original);
  });
});
