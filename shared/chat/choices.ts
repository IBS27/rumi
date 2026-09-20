// The agent is told to offer choices only through option cards. When it slips
// and writes a numbered or bulleted list of choices as text, the reply is
// turned into a card here so the user can still click.

const ITEM = /^\s*(?:\d{1,2}[.)]|[a-dA-D][.)]|[-•*])\s+(.+?)\s*$/;
const MAX_OPTIONS = 4;
const MIN_OPTIONS = 2;

export interface ChoiceCard {
  question: string;
  options: string[];
  multiSelect: boolean;
  // Text before the list, kept as the reply body when it is more than the question.
  intro: string;
}

const MULTI = /\b(all that apply|one or more|any that|several|multiple|as many|which of these (?:do|would) you like)\b/i;

function clean(value: string): string {
  return value
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/[.:;,]+$/, "")
    .trim();
}

// Returns a card when the text ends in a short list of choices, else null.
// A list of facts (long items, no question nearby) is left alone.
export function choiceListToCard(text: string): ChoiceCard | null {
  const lines = text.split(/\r?\n/);
  let end = lines.length;
  const skipBlank = () => {
    while (end > 0 && !lines[end - 1].trim()) end--;
  };
  skipBlank();
  // Allow a short closing paragraph after the list ("Let me know which one
  // fits best or suggest another purpose!"): up to two lines, no list items.
  const closing: string[] = [];
  while (
    end > 0 &&
    closing.length < 2 &&
    !ITEM.test(lines[end - 1]) &&
    lines[end - 1].trim().length <= 200
  ) {
    closing.unshift(lines[end - 1].trim());
    end--;
    skipBlank();
  }
  const trailing = closing.join(" ");
  const items: string[] = [];
  let start = end;
  while (start > 0) {
    const line = lines[start - 1];
    if (!line.trim()) {
      // Blank lines between items are fine; a blank before the first item ends the list.
      if (start - 1 > 0 && ITEM.test(lines[start - 2])) {
        start--;
        continue;
      }
      break;
    }
    const match = ITEM.exec(line);
    if (!match) break;
    items.unshift(clean(match[1]));
    start--;
  }
  // Without any items, the closing lines were just the reply's last paragraph.
  if (items.length === 0) return null;
  if (items.length < MIN_OPTIONS || items.length > 6) return null;
  // Choices are short; a list of long sentences is an explanation, not a menu.
  if (items.some((item) => item.length === 0 || item.length > 60)) return null;
  const before = lines.slice(0, start).join("\n").trim();
  const paragraphs = before.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paragraphs.at(-1) ?? "";
  const asksQuestion = /\?\s*$/.test(last) || /\?\s*$/.test(trailing);
  const invites = /\b(which|choose|pick|prefer|would you|do you|select|option|like)\b/i.test(
    `${last} ${trailing}`,
  );
  if (!asksQuestion && !invites) return null;
  const question = /\?\s*$/.test(last)
    ? last.replace(/\n+/g, " ")
    : trailing && /\?\s*$/.test(trailing)
      ? trailing
      : last.replace(/\n+/g, " ") || "Which would you like?";
  const intro = paragraphs.slice(0, -1).join("\n\n");
  // "What is this room for? Here are some options to choose from:" → keep the question only.
  const firstQuestion = /^(.*?\?)/.exec(question)?.[1] ?? question;
  return {
    question: firstQuestion.replace(/:\s*$/, "").trim() || "Which would you like?",
    options: [...new Set(items)].slice(0, MAX_OPTIONS),
    multiSelect: MULTI.test(`${last} ${trailing}`),
    intro,
  };
}
