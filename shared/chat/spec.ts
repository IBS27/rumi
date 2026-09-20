import type { DesignBrief, SpecTopic } from "../contracts";

// What Spec has settled so far. A topic counts as decided when its field
// holds a value, or when the user answered it with "nothing" (you choose, no
// budget yet) and the agent recorded that in brief.decided.
export const SPEC_TOPICS: SpecTopic[] = [
  "purpose",
  "style",
  "items",
  "accessories",
  "budget",
];

export interface SpecStatus {
  decided: SpecTopic[];
  missing: SpecTopic[];
  complete: boolean;
}

function hasValue(brief: DesignBrief, topic: SpecTopic): boolean {
  switch (topic) {
    case "purpose":
      return brief.purpose.trim().length > 0;
    case "style":
      return (
        brief.styles.length > 0 ||
        brief.palette.length > 0 ||
        brief.inspiration.trim().length > 0
      );
    case "items":
      return brief.wants.length > 0;
    case "accessories":
      return brief.accessories !== "unspecified";
    case "budget":
      return brief.budgetCents > 0;
  }
}

export function specStatus(brief: DesignBrief): SpecStatus {
  const decided = SPEC_TOPICS.filter(
    (topic) => hasValue(brief, topic) || brief.decided.includes(topic),
  );
  const missing = SPEC_TOPICS.filter((topic) => !decided.includes(topic));
  return { decided, missing, complete: missing.length === 0 };
}

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);

// One line per topic, in the words the summary card and the prompt share.
export function describeSpec(brief: DesignBrief): Record<SpecTopic, string> {
  const status = specStatus(brief);
  const line = (topic: SpecTopic, value: string) =>
    status.decided.includes(topic) ? value : "not decided yet";
  return {
    purpose: line("purpose", brief.purpose || "not stated"),
    style: line(
      "style",
      [
        brief.styles.join(", "),
        brief.materials.length ? `materials: ${brief.materials.join(", ")}` : "",
        brief.palette.length ? `palette: ${brief.palette.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ") || "from your inspiration image",
    ),
    items: line(
      "items",
      brief.wants.length
        ? brief.wants
            .map((want) => (want.notes ? `${want.category} (${want.notes})` : want.category))
            .join(", ")
        : "I'll choose what fits the space",
    ),
    accessories: line(
      "accessories",
      brief.accessories === "include"
        ? "included"
        : brief.accessories === "skip"
          ? "furniture only"
          : "I'll decide",
    ),
    budget: line("budget", brief.budgetCents > 0 ? money(brief.budgetCents) : "no budget set"),
  };
}

export function specSummaryText(brief: DesignBrief): string {
  const lines = describeSpec(brief);
  const extra = brief.restrictions.length
    ? `\nRestrictions: ${brief.restrictions.join(", ")}`
    : "";
  return [
    "Here is the brief so far.",
    `Purpose: ${lines.purpose}`,
    `Style: ${lines.style}`,
    `Items: ${lines.items}`,
    `Accessories: ${lines.accessories}`,
    `Budget: ${lines.budget}${extra}`,
    "",
    "Ready to start planning, or would you like to change something? You can also type a change below, like “add a desk”.",
  ].join("\n");
}

export const SPEC_SUMMARY_OPTIONS = ["Start planning", "Modify details"];

// The status line the agent reads at the start of every Spec turn.
export function specStatusLine(brief: DesignBrief): string {
  const status = specStatus(brief);
  const lines = describeSpec(brief);
  const decided = status.decided.map((topic) => `${topic} (${lines[topic]})`);
  return [
    `Spec status — decided: ${decided.length ? decided.join("; ") : "nothing yet"}.`,
    status.missing.length
      ? `Still to ask, in order: ${status.missing.join(", ")}. Do not ask about a decided topic again.`
      : "Everything is decided. If the summary card has not been shown since the last change, call showSpecSummary; if the user just asked to modify something, ask what to change instead.",
  ].join(" ");
}
