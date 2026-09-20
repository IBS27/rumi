import { useState } from "react";
import { useMutation } from "convex/react";
import { Check, ArrowUp } from "lucide-react";
import type { Doc } from "../../../convex/_generated/dataModel";
import { api } from "../../../convex/_generated/api";

export function OptionsCard({
  message,
  disabled,
  prepare,
}: {
  message: Doc<"messages">;
  disabled: boolean;
  prepare: () => Promise<void>;
}) {
  const answer = useMutation(api.messages.answer);
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answered = message.answer !== undefined;
  async function respond(choice: string[]) {
    if (busy || disabled || answered || !choice.length) return;
    setBusy(true);
    setError("");
    try {
      await prepare();
      await answer({ messageId: message._id, choice });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save your answer.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="chat-question">
      <p>{message.content}</p>
      <div className="chat-options">
        {message.options?.map((option) => {
          const active = (message.answer ?? selected).includes(option);
          return (
            <button
              key={option}
              aria-pressed={active}
              disabled={answered || disabled || busy}
              onClick={() => {
                if (message.multiSelect)
                  setSelected((values) =>
                    values.includes(option)
                      ? values.filter((value) => value !== option)
                      : [...values, option],
                  );
                else void respond([option]);
              }}
            >
              <span>{option}</span>
              {active && <Check size={15} />}
            </button>
          );
        })}
      </div>
      {!answered && (
        <form
          className="custom-answer"
          onSubmit={(event) => {
            event.preventDefault();
            void respond(
              message.multiSelect
                ? [...selected, ...(custom.trim() ? [custom.trim()] : [])]
                : [custom.trim()],
            );
          }}
        >
          <input
            aria-label="Custom answer"
            placeholder="Or your own answer…"
            value={custom}
            maxLength={1000}
            onChange={(event) => setCustom(event.target.value)}
            disabled={disabled || busy}
          />
          <button
            aria-label="Submit answer"
            disabled={
              disabled ||
              busy ||
              (!custom.trim() && (!message.multiSelect || !selected.length))
            }
          >
            <ArrowUp size={16} />
          </button>
        </form>
      )}
      {answered && (
        <small className="chat-answer">
          Answered: {message.answer?.join(", ")}
        </small>
      )}
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
