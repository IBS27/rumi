import type { ReactNode } from "react";
import { Check, ExternalLink, LoaderCircle, X } from "lucide-react";
import { MessageBubble } from "../../ui";

type Recommendation = {
  id: string;
  name: string;
  merchant: string;
  sourceUrl: string;
  imageUrl: string | null;
  priceCents: number;
};

type ActivityItem = {
  id: string;
  tool: string;
  label: string;
  detail?: string;
  status: "running" | "done" | "error";
};

function RippleDots() {
  return (
    <span className="ml-1 inline-flex items-end gap-0.5" aria-label="Streaming">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1 rounded-full bg-teal motion-safe:animate-bounce"
          style={{ animationDelay: `${index * 140}ms` }}
        />
      ))}
    </span>
  );
}

function ActivityRows({ activity }: { activity: ActivityItem[] }) {
  return (
    <div className="space-y-1">
      {activity.map((item) => (
        <div
          key={item.id}
          className="flex items-start gap-1.5 text-[11px] text-mute"
        >
          {item.status === "running" ? (
            <LoaderCircle className="mt-0.5 size-3 shrink-0 motion-safe:animate-spin" />
          ) : item.status === "done" ? (
            <Check className="mt-0.5 size-3 shrink-0 text-teal-deep" />
          ) : (
            <X className="mt-0.5 size-3 shrink-0 text-rust" />
          )}
          <span className="[overflow-wrap:anywhere]">
            {item.label}
            {item.detail ? ` — ${item.detail}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function ActivityFeed({
  activity,
  pending,
}: {
  activity?: ActivityItem[];
  pending: boolean;
}) {
  if (!activity?.length) return null;
  if (pending)
    return (
      <div className="mb-2 rounded-ctrl border border-line bg-chalk px-2.5 py-2">
        <ActivityRows activity={activity} />
      </div>
    );
  return (
    <details className="mb-1.5 text-[11px] text-mute">
      <summary className="cursor-pointer select-none hover:text-ink">
        {activity.length} agent step{activity.length === 1 ? "" : "s"}
      </summary>
      <div className="mt-1.5 border-l border-line pl-2">
        <ActivityRows activity={activity} />
      </div>
    </details>
  );
}

function ProductCard({ product }: { product: Recommendation }) {
  const price = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(product.priceCents / 100);
  return (
    <article className="overflow-hidden rounded-tile border border-line bg-white">
      {product.imageUrl ? (
        <img
          src={product.imageUrl}
          alt={product.name}
          className="h-44 w-full bg-chalk object-contain"
        />
      ) : (
        <div className="grid h-24 place-items-center bg-chalk text-[11px] text-mute">
          No product image available
        </div>
      )}
      <h4 className="px-3 pt-2.5 pb-2 text-[13px] font-medium leading-snug text-ink">
        {product.name}
      </h4>
      <div className="px-3 pt-0.5 pb-3">
        <div className="mb-2 flex items-center justify-between gap-2 text-xs">
          <span className="font-medium text-ink">{price}</span>
          <span className="truncate text-mute">{product.merchant}</span>
        </div>
        <a
          href={product.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-between gap-2 border-t border-line pt-2 text-[11px] font-medium text-teal-deep no-underline hover:text-ink"
        >
          View product
          <ExternalLink className="size-3 shrink-0" />
        </a>
      </div>
    </article>
  );
}

type ChatMessageData = {
  role: "user" | "assistant" | "system";
  status?: "pending" | "done" | "error";
  content: string;
  imageUrl?: string | null;
  recommendation?: Recommendation | null;
  activity?: ActivityItem[];
};

export function ChatMessage({
  message,
  children,
}: {
  message: ChatMessageData;
  children?: ReactNode;
}) {
  const pending = message.status === "pending";
  const productReply = message.role === "assistant" && !!message.recommendation;
  const showText = !productReply || message.status === "error";
  return (
    <MessageBubble speaker={message.role} card={productReply}>
      {message.role === "assistant" && (
        <ActivityFeed activity={message.activity} pending={pending} />
      )}
      {message.imageUrl && (
        <a href={message.imageUrl} target="_blank" rel="noreferrer">
          <img
            className="mb-2 max-h-56 w-full rounded-ctrl object-contain"
            src={message.imageUrl}
            alt="Your inspiration image"
          />
        </a>
      )}
      {showText && message.content && (
        <p
          className={`whitespace-pre-wrap ${message.status === "error" ? "text-rust" : ""}`}
        >
          {message.content}
          {pending && <RippleDots />}
        </p>
      )}
      {pending &&
        !message.content &&
        !message.activity?.length &&
        !productReply && (
          <p role="status" className="text-mute">
            Thinking
            <RippleDots />
          </p>
        )}
      {message.recommendation && (
        <ProductCard product={message.recommendation} />
      )}
      {productReply &&
        message.content &&
        !pending &&
        message.status !== "error" && (
          <details className="mt-2 text-xs text-mute">
            <summary className="w-fit cursor-pointer rounded-ctrl hover:text-teal-deep">
              Rumi's notes
            </summary>
            <p className="mt-2 whitespace-pre-wrap leading-relaxed">
              {message.content}
            </p>
          </details>
        )}
      {children}
    </MessageBubble>
  );
}
