import { describe, expect, it } from "bun:test";
import { briefSchema, type DesignBrief } from "../shared/contracts";
import {
  SPEC_SUMMARY_OPTIONS,
  specStatus,
  specStatusLine,
  specSummaryText,
} from "../shared/chat/spec";

const empty = (): DesignBrief =>
  briefSchema.parse({
    prompt: "",
    styles: [],
    budgetCents: 0,
    currency: "USD",
    restrictions: [],
  });

describe("spec status", () => {
  it("starts with nothing decided and lists the topics in asking order", () => {
    const status = specStatus(empty());
    expect(status.decided).toEqual([]);
    expect(status.missing).toEqual(["purpose", "style", "items", "accessories", "budget"]);
    expect(status.complete).toBe(false);
    expect(specStatusLine(empty())).toContain("Still to ask, in order: purpose, style");
  });

  it("counts a topic decided when its field holds a value", () => {
    const brief = { ...empty(), purpose: "bedroom", styles: ["cozy"], budgetCents: 250000 };
    const status = specStatus(brief);
    expect(status.decided).toEqual(["purpose", "style", "budget"]);
    expect(status.missing).toEqual(["items", "accessories"]);
    // A passing mention of "cozy" keeps the style question from coming back.
    expect(specStatusLine(brief)).toContain("style (cozy)");
    expect(specStatusLine(brief)).not.toContain("Still to ask, in order: style");
  });

  it("treats an inspiration image as a style direction", () => {
    expect(specStatus({ ...empty(), inspiration: "Warm minimal room." }).decided).toEqual(["style"]);
    expect(specStatus({ ...empty(), palette: ["sage green"] }).decided).toEqual(["style"]);
  });

  it("lets 'you choose' and 'no budget yet' decide a topic with an empty field", () => {
    const brief = {
      ...empty(),
      purpose: "office",
      styles: ["industrial"],
      accessories: "skip" as const,
      decided: ["items" as const, "budget" as const],
    };
    const status = specStatus(brief);
    expect(status.complete).toBe(true);
    expect(specStatusLine(brief)).toContain("Everything is decided.");
    expect(specStatusLine(brief)).toContain("call showSpecSummary");
    const text = specSummaryText(brief);
    expect(text).toContain("Items: I'll choose what fits the space");
    expect(text).toContain("Budget: no budget set");
    expect(text).toContain("Accessories: furniture only");
    expect(SPEC_SUMMARY_OPTIONS).toEqual(["Start planning", "Modify details"]);
  });

  it("writes the summary from the brief, not from the model", () => {
    const text = specSummaryText({
      ...empty(),
      purpose: "bedroom",
      styles: ["modern", "cozy"],
      materials: ["oak"],
      wants: [{ category: "desk", notes: "at least 1.2 m wide" }],
      accessories: "include",
      budgetCents: 400000,
      restrictions: ["no drilling"],
      decided: [],
    });
    expect(text).toContain("Purpose: bedroom");
    expect(text).toContain("Style: modern, cozy; materials: oak");
    expect(text).toContain("Items: desk (at least 1.2 m wide)");
    expect(text).toContain("Accessories: included");
    expect(text).toContain("Budget: $4,000");
    expect(text).toContain("Restrictions: no drilling");
    expect(text).not.toContain("**");
  });
});
