import { describe, expect, it } from "vitest";
import {
  designBriefFromDraft,
  designBriefToDraft,
} from "./design-mate-form";

describe("Design Mate brief form", () => {
  it("round-trips document fields through the text draft", () => {
    const brief = {
      brandName: "Northstar",
      offering: "Navigation software",
      audience: "Field teams",
      attributes: ["clear", "dependable"],
      avoid: ["generic compass"],
      competitors: ["Atlas"],
      primaryUseCases: ["mobile app", "workwear"],
      mustKeep: ["north motif"],
      constraints: "One-color friendly",
      notes: "Explore a geometric direction.",
    };

    expect(designBriefFromDraft(designBriefToDraft(brief))).toEqual(brief);
  });

  it("accepts comma or newline lists and clears an empty brief", () => {
    const draft = designBriefToDraft(undefined);
    draft.attributes = " precise, warm\nprecise ";

    expect(designBriefFromDraft(draft)).toEqual({
      attributes: ["precise", "warm"],
    });
    expect(designBriefFromDraft(designBriefToDraft(undefined))).toBeUndefined();
  });
});
