import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { PanelLeftClose } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { getOwnerId } from "../../lib/clientId";
import { ChatMenu } from "./ChatMenu";
import { Composer } from "./Composer";
import { OptionsCard } from "./OptionsCard";

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

export function ChatPanel({
  projectId,
  onCollapse,
}: {
  projectId: Id<"projects">;
  onCollapse?: () => void;
}) {
  const ownerId = getOwnerId();
  const messages = useQuery(api.messages.list, { projectId, ownerId });
  const send = useMutation(api.messages.send);
  const generateUploadUrl = useMutation(api.images.generateUploadUrl);
  const saveImage = useMutation(api.images.save);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pending = messages?.some(
    (message) => message.status === "pending" && message.kind !== "question",
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages?.length, pending]);

  const upload = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setUploadError("Choose an image file.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setUploadError("Images must be 10 MB or smaller.");
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const uploadUrl = await generateUploadUrl({ projectId, ownerId });
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) throw new Error("The image upload failed.");
      const { storageId } = (await response.json()) as {
        storageId: Id<"_storage">;
      };
      await saveImage({
        projectId,
        ownerId,
        storageId,
        contentType: file.type,
      });
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : "The image upload failed.",
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className="flex h-dvh flex-col border-r border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between px-3 pt-3">
        <ChatMenu />
        {onCollapse && (
          <button
            onClick={onCollapse}
            aria-label="Collapse chat"
            title="Collapse chat"
            className="grid size-8 place-items-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
          >
            <PanelLeftClose className="size-[17px]" />
          </button>
        )}
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-6">
        {messages?.map((message) => {
          if (message.kind === "question")
            return <OptionsCard key={message._id} message={message} />;
          if (message.status === "pending")
            return (
              <div key={message._id} className="pr-8">
                <Thinking />
              </div>
            );
          if (message.role === "assistant" && !message.content) return null;
          if (message.role === "user")
            return (
              <div key={message._id} className="flex justify-end pl-8">
                <div className="max-w-full overflow-hidden rounded-2xl bg-neutral-800 text-[14px] leading-6 text-neutral-100">
                  {message.imageUrl && (
                    <img
                      src={message.imageUrl}
                      alt="Uploaded inspiration"
                      className="max-h-64 w-full object-cover"
                    />
                  )}
                  <p className="px-3.5 py-2">
                    {message.imageUrl ? "Inspiration image" : message.content}
                  </p>
                </div>
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
        {(uploading || uploadError) && (
          <p
            className={`mb-2 px-1 text-[11px] ${uploadError ? "text-red-400" : "text-neutral-500"}`}
          >
            {uploadError ?? "Uploading and analyzing image…"}
          </p>
        )}
        <Composer
          onSend={(text) =>
            void send({ projectId, ownerId, content: text })
          }
          onUpload={(file) => void upload(file)}
          uploading={uploading}
          disabled={pending}
          placeholder={
            pending ? "Thinking…" : "Ask for changes, or set a budget…"
          }
        />
      </div>
    </section>
  );
}
