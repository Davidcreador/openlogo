import { describe, expect, it } from "vitest";
import { shouldCloseFontPickerOnBlur } from "./FontPicker";

describe("shouldCloseFontPickerOnBlur", () => {
  it("keeps the panel open when relatedTarget is null (option / scrollbar click)", () => {
    const panel = { contains: () => false };
    const trigger = { contains: () => false };
    expect(shouldCloseFontPickerOnBlur(panel, trigger, null)).toBe(false);
  });

  it("keeps the panel open when focus moves to a node inside the panel", () => {
    const inside = {} as Node;
    const panel = { contains: (node: Node | null) => node === inside };
    const trigger = { contains: () => false };
    expect(shouldCloseFontPickerOnBlur(panel, trigger, inside)).toBe(false);
  });

  it("keeps the panel open when focus returns to the trigger", () => {
    const triggerNode = {} as Node;
    const panel = { contains: () => false };
    const trigger = { contains: (node: Node | null) => node === triggerNode };
    expect(shouldCloseFontPickerOnBlur(panel, trigger, triggerNode)).toBe(false);
  });

  it("closes when focus moves to a node outside the panel and trigger", () => {
    const outside = {} as Node;
    const panel = { contains: () => false };
    const trigger = { contains: () => false };
    expect(shouldCloseFontPickerOnBlur(panel, trigger, outside)).toBe(true);
  });
});
