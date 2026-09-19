import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { getOwnerId } from "../../lib/clientId";
import { useWorkspace } from "../../lib/store";
import { ChatMenu } from "./ChatMenu";
import { Composer } from "./Composer";

const SUGGESTIONS = [
  "A modern minimalist bedroom, budget $500",
  "Cozy reading corner with warm lighting",
  "Small studio workspace, nothing mounted to walls",
];

export function ChatLanding({ connected }: { connected: boolean }) {
  const create = useMutation(api.projects.create);
  const send = useMutation(api.messages.send);
  const setActiveProject = useWorkspace((state) => state.setActiveProject);
  const handle = async (text: string) => {
    const ownerId = getOwnerId();
    const projectId = await create({
      ownerId,
      title: text.length > 48 ? `${text.slice(0, 48)}…` : text,
    });
    setActiveProject(projectId);
    await send({ projectId, ownerId, content: text });
  };
  return (
    <div className="relative grid h-dvh place-items-center bg-neutral-950 px-6 text-neutral-100">
      {connected && (
        <div className="absolute left-4 top-4">
          <ChatMenu />
        </div>
      )}
      <div className="w-full max-w-2xl">
        <h1 className="mb-2 text-center text-3xl font-medium tracking-tight">
          rumi
        </h1>
        <p className="mb-8 text-center text-sm text-neutral-500">
          Describe the room you want and a budget. I'll design it with real
          products.
        </p>
        <Composer
          onSend={(text) => void handle(text)}
          disabled={!connected}
          placeholder={
            connected
              ? "Modern minimalist bedroom, keep my desk, $500…"
              : "Set VITE_CONVEX_URL to connect the backend."
          }
        />
        {connected && (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                onClick={() => void handle(suggestion)}
                className="rounded-full border border-neutral-800 px-3 py-1.5 text-[12px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
