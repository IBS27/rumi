import { describe, expect, it } from "bun:test";
import { briefSchema, type DesignBrief } from "../shared/contracts";
import {
  SPEC_SUMMARY_OPTIONS,
  specStatus,
  specStatusLine,
  specSummaryText,
} from "../shared/chat/spec";
import { inferPurpose } from "../shared/chat/purpose";
import { shouldForcePlanSpace } from "../shared/chat/planning";

const empty = (): DesignBrief =>
  briefSchema.parse({
    prompt: "",
    styles: [],
    budgetCents: 0,
    currency: "USD",
    restrictions: [],
  });

describe("spec status", () => {
  it("routes explicit and acknowledged layout retries back through planning", () => {
    expect(shouldForcePlanSpace("plan", "Start planning. now", "")).toBe(
      true,
    );
    expect(
      shouldForcePlanSpace(
        "plan",
        "ok",
        "The bed could not be reserved. I can try a smaller bed.",
      ),
    ).toBe(true);
    expect(shouldForcePlanSpace("spec", "Start planning now", "")).toBe(
      false,
    );
    expect(shouldForcePlanSpace("plan", "I like oak", "Looks good.")).toBe(
      false,
    );
  });

  it("leaves questions, room edits, and placement facts to normal tool selection after a failure", () => {
    const failed = "The bed could not fit. I can try a smaller bed.";
    for (const message of [
      "Move the bed closer to the wall",
      "Please rotate the bed",
      "Keep the bed where it is",
      "How much space is left?",
      "Would a smaller bed fit?",
      "Can you explain why it cannot fit",
      "Should I start planning now?",
      "The shelf is gone, so the bed fits now",
      "Start planning after moving the bed",
      "Start planning and remove the desk",
      "Try a smaller bed and make it oak",
    ]) expect(shouldForcePlanSpace("plan", message, failed)).toBe(false);
    expect(shouldForcePlanSpace("plan", "Please try a smaller bed.", failed)).toBe(true);
    expect(shouldForcePlanSpace("plan", "Try a different placement", failed)).toBe(true);
    expect(shouldForcePlanSpace("plan", "Try a smaller bed", "The plan is ready.")).toBe(false);
    expect(shouldForcePlanSpace("plan", "yes", "The plan is ready.")).toBe(false);
  });

  it("recognizes a room purpose stated in a casual furniture request", () => {
    expect(inferPurpose("I need some furniture for my bedroom")).toBe(
      "bedroom",
    );
    expect(inferPurpose("Help with this scan", "Upstairs home office")).toBe(
      "home office",
    );
  });

  it("does not force planning before exclusions, revised wants, or cancellation are saved", () => {
    const failed = "The bed couldn't fit because of space constraints.";
    for (const message of [
      "i do not need the bed", "I don't want a bed", "Start planning without a bed",
      "no", "stop planning", "Add a desk instead", "I only want storage",
    ]) expect(shouldForcePlanSpace("plan", message, failed)).toBe(false);
    expect(shouldForcePlanSpace("plan", "no go for it", failed)).toBe(true);
    expect(shouldForcePlanSpace("plan", "try a smaller bed", failed)).toBe(true);
  });

  it("shows saved furniture exclusions in the brief summary", () => {
    expect(specSummaryText({ ...empty(), excludedCategories: ["bed"] }))
      .toContain("Do not shop for: bed");
    expect(briefSchema.parse(empty()).excludedCategories).toBeUndefined();
  });

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
