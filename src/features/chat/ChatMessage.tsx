import type { ReactNode } from "react";
import { Check, ExternalLink, LoaderCircle, X } from "lucide-react";
import { MessageBubble, Pill } from "../../ui";
import type { PillTone } from "../../ui/Pill";
import { RichText } from "./RichText";

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

type ZoneCard = {
  zoneId: string;
  category: string;
  fits: "yes" | "no" | "unknown";
  issues: string[];
  product: Recommendation | null;
};

const FIT: Record<ZoneCard["fits"], { tone: PillTone; label: string }> = {
  yes: { tone: "ok", label: "fits the space" },
  no: { tone: "warn", label: "does not fit" },
  unknown: { tone: "estimated", label: "size unconfirmed" },
};

// One card per planned zone: the category it fills, the fit verdict, then the
// product itself (or the reason nothing was found).
function ZoneProductCard({ card }: { card: ZoneCard }) {
  const fit = FIT[card.fits];
  return (
    <section aria-label={card.category}>
      <div className="mb-1 flex flex-wrap items-center gap-1.5 px-0.5">
        <span className="text-[12px] font-medium capitalize text-ink">
          {card.category}
        </span>
        {card.product && <Pill tone={fit.tone}>{fit.label}</Pill>}
      </div>
      {card.product ? (
        <ProductCard product={card.product} />
      ) : (
        <div className="rounded-tile border border-dashed border-line px-3 py-2.5 text-[11px] text-mute">
          Nothing suitable found for this spot yet.
        </div>
      )}
      {card.issues.length > 0 && (
        <ul className="mt-1 px-0.5 text-[11px] leading-relaxed text-mute">
          {card.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

type ChatMessageData = {
  role: "user" | "assistant" | "system";
  status?: "pending" | "done" | "error";
  content: string;
  imageUrl?: string | null;
  imageAnalysis?: string | null;
  recommendation?: Recommendation | null;
  zoneCards?: ZoneCard[];
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
  const zoneCards = message.zoneCards ?? [];
  const productReply =
    message.role === "assistant" &&
    (!!message.recommendation || zoneCards.length > 0);
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
        <div className={message.status === "error" ? "text-rust" : ""}>
          <RichText text={message.content} />
          {pending && <RippleDots />}
        </div>
      )}
      {message.imageAnalysis && (
        <details className="mt-2 text-xs text-mute">
          <summary className="w-fit cursor-pointer rounded-ctrl hover:text-teal-deep">
            What Rumi saw
          </summary>
          <RichText
            text={message.imageAnalysis}
            className="mt-2 leading-relaxed"
          />
        </details>
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
      {zoneCards.length > 0 ? (
        <div className="flex flex-col gap-3">
          {zoneCards.map((card) => (
            <ZoneProductCard key={card.zoneId} card={card} />
          ))}
        </div>
      ) : (
        message.recommendation && (
          <ProductCard product={message.recommendation} />
        )
      )}
      {productReply &&
        message.content &&
        !pending &&
        message.status !== "error" && (
          <details className="mt-2 text-xs text-mute">
            <summary className="w-fit cursor-pointer rounded-ctrl hover:text-teal-deep">
              Rumi's notes
            </summary>
            <RichText text={message.content} className="mt-2 leading-relaxed" />
          </details>
        )}
      {children}
    </MessageBubble>
  );
}
