import type { ReactNode } from "react";

// Chat text arrives as light Markdown from the models. Render the few forms
// that occur (headings, bold, bullets, "Label: value" lines) as styled text
// instead of showing the raw markers. Anything else stays literal.

function inline(text: string, keyBase: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      match[1] !== undefined ? (
        <strong key={`${keyBase}-${index++}`} className="font-medium text-ink">
          {match[1]}
        </strong>
      ) : (
        <code key={`${keyBase}-${index++}`} className="rounded bg-wash px-1 text-[12px]">
          {match[2]}
        </code>
      ),
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// "Palette: neutral base" → label in bold, value after it.
function labeled(line: string, key: string): ReactNode {
  const match = /^([A-Z][\w /&-]{1,24}):\s+(.+)$/.exec(line);
  if (!match) return <p key={key}>{inline(line, key)}</p>;
  return (
    <p key={key}>
      <span className="font-medium text-ink">{match[1]}:</span>{" "}
      {inline(match[2], key)}
    </p>
  );
}

export function RichText({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let list: string[] = [];
  const flushList = () => {
    if (!list.length) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="my-1 list-disc space-y-0.5 pl-4">
        {list.map((item, i) => (
          <li key={i}>{inline(item, `li-${blocks.length}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const key = `l-${i}`;
    if (!line) {
      flushList();
      return;
    }
    const bullet = /^(?:[-•*]|\d{1,2}[.)])\s+(.+)$/.exec(line);
    if (bullet) {
      list.push(bullet[1]);
      return;
    }
    flushList();
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(
        <p key={key} className="mt-2 mb-0.5 font-medium text-ink first:mt-0">
          {inline(heading[1].replace(/\*\*/g, ""), key)}
        </p>,
      );
      return;
    }
    blocks.push(labeled(line.replace(/^\*\*(.+?):\*\*/, "$1:"), key));
  });
  flushList();
  return <div className={`space-y-1.5 ${className}`}>{blocks}</div>;
}
