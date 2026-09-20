import { Button, TextInput, Panel } from "../../ui";
import { useState } from "react";
import { useMutation } from "convex/react";
import { Check, ArrowUp } from "lucide-react";
import type { Doc } from "../../../convex/_generated/dataModel";
import { api } from "../../../convex/_generated/api";
import { RichText } from "./RichText";

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
    <Panel
      tone="stone"
      className="shrink-0 rounded-tile p-3 text-[12.5px]"
    >
      <RichText text={message.content} className="mb-2.5" />
      <div className="flex flex-col gap-1.5 [&>button]:justify-between [&>button]:whitespace-normal [&>button]:text-left [&>button]:leading-relaxed [&>button[aria-pressed=true]]:border-teal [&>button[aria-pressed=true]]:bg-teal-tint [&>button[aria-pressed=true]]:opacity-100">
        {message.options?.map((option) => {
          const active = (message.answer ?? selected).includes(option);
          return (
            <Button
              size="sm"
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
            </Button>
          );
        })}
      </div>
      {!answered && (
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void respond(
              message.multiSelect
                ? [...selected, ...(custom.trim() ? [custom.trim()] : [])]
                : [custom.trim()],
            );
          }}
        >
          <TextInput
            aria-label="Custom answer"
            placeholder="Or your own answer…"
            value={custom}
            maxLength={1000}
            onChange={(event) => setCustom(event.target.value)}
            disabled={disabled || busy}
          />
          <Button
            size="sm"
            type="submit"
            aria-label="Submit answer"
            disabled={
              disabled ||
              busy ||
              (!custom.trim() && (!message.multiSelect || !selected.length))
            }
          >
            <ArrowUp size={16} />
          </Button>
        </form>
      )}
      {answered && (
        <small className="mt-2 block text-[11px] text-teal-deep">
          Answered: {message.answer?.join(", ")}
        </small>
      )}
      {error && (
        <p
          className="text-xs leading-relaxed text-rust [overflow-wrap:anywhere]"
          role="alert"
        >
          {error}
        </p>
      )}
    </Panel>
  );
}
