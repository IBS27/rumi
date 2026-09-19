import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { getOwnerId } from "../../lib/clientId";
import { ChatMenu } from "./ChatMenu";
import { Composer } from "./Composer";

function Thinking() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="Thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-pulse rounded-full bg-neutral-500"
          style={{ animationDelay: `${i * 200}ms` }}
        />
      ))}
    </span>
  );
}

export function ChatPanel({ projectId }: { projectId: Id<"projects"> }) {
  const ownerId = getOwnerId();
  const messages = useQuery(api.messages.list, { projectId, ownerId });
  const send = useMutation(api.messages.send);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pending = messages?.some((message) => message.status === "pending");

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages?.length, pending]);

  return (
    <section className="flex h-dvh flex-col border-r border-neutral-800 bg-neutral-950">
      <div className="px-3 pt-3">
        <ChatMenu />
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-6">
        {messages?.map((message) => {
          if (message.status === "pending")
            return (
              <div key={message._id} className="pr-8">
                <Thinking />
              </div>
            );
          if (message.role === "user")
            return (
              <div key={message._id} className="flex justify-end pl-8">
                <p className="rounded-2xl bg-neutral-800 px-3.5 py-2 text-[14px] leading-6 text-neutral-100">
                  {message.content}
                </p>
              </div>
            );
          return (
            <div key={message._id} className="pr-8">
              <p
                className={`text-[14px] leading-6 whitespace-pre-wrap ${
                  message.status === "error"
                    ? "text-red-400"
                    : "text-neutral-300"
                }`}
              >
                {message.content}
              </p>
            </div>
          );
        })}
      </div>
      <div className="px-4 pb-4">
        <Composer
          onSend={(text) =>
            void send({ projectId, ownerId, content: text })
          }
          disabled={pending}
          placeholder={
            pending ? "Thinking…" : "Ask for changes, or set a budget…"
          }
        />
      </div>
    </section>
  );
}
