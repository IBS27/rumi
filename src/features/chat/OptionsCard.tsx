import { useState } from "react";
import { useMutation } from "convex/react";
import { ArrowUp } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { getOwnerId } from "../../lib/clientId";

export function OptionsCard({ message }: { message: Doc<"messages"> }) {
  const ownerId = getOwnerId();
  const answer = useMutation(api.messages.answer);
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const answered = message.answer !== undefined;
  const options = message.options ?? [];

  const respond = (choice: string[]) =>
    void answer({ messageId: message._id, ownerId, choice });

  const pick = (option: string) => {
    if (answered) return;
    if (message.multiSelect) {
      setSelected((current) =>
        current.includes(option)
          ? current.filter((item) => item !== option)
          : [...current, option],
      );
    } else {
      respond([option]);
    }
  };

  const submitOther = () => {
    const text = other.trim();
    if (!text || answered) return;
    respond(message.multiSelect ? [...selected, text] : [text]);
  };

  return (
    <div className="pr-8">
      <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-3.5">
        <p className="mb-3 text-[14px] leading-6 text-neutral-200">
          {message.content}
        </p>
        <div className="flex flex-col gap-1.5">
          {options.map((option) => {
            const active = answered
              ? message.answer?.includes(option)
              : selected.includes(option);
            return (
              <button
                key={option}
                onClick={() => pick(option)}
                disabled={answered}
                className={`rounded-lg border px-3 py-2 text-left text-[13px] transition-colors ${
                  active
                    ? "border-neutral-500 bg-neutral-800 text-neutral-100"
                    : "border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:bg-neutral-800/60 hover:text-neutral-200"
                } ${answered && !active ? "opacity-40" : ""}`}
              >
                {option}
              </button>
            );
          })}
        </div>
        {!answered && (
          <div className="mt-2.5 flex items-center gap-2">
            <input
              value={other}
              onChange={(event) => setOther(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitOther();
                }
              }}
              placeholder="Type your own answer…"
              className="min-w-0 flex-1 rounded-lg border border-neutral-800 bg-transparent px-3 py-2 text-[13px] text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-neutral-600"
            />
            <button
              onClick={submitOther}
              disabled={!other.trim()}
              aria-label="Submit answer"
              className="grid size-8 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-900 transition-opacity hover:opacity-80 disabled:opacity-30"
            >
              <ArrowUp className="size-4" strokeWidth={2.5} />
            </button>
          </div>
        )}
        {message.multiSelect && !answered && (
          <button
            onClick={() => selected.length && respond(selected)}
            disabled={!selected.length}
            className="mt-2.5 rounded-lg bg-neutral-100 px-3 py-1.5 text-[12px] font-medium text-neutral-900 transition-opacity hover:opacity-80 disabled:opacity-30"
          >
            Confirm selection
          </button>
        )}
        {answered && (
          <p className="mt-2.5 text-[11px] uppercase tracking-wider text-neutral-600">
            Answered
          </p>
        )}
      </div>
    </div>
  );
}
