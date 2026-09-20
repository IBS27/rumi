import { useState } from "react";
import { useMutation } from "convex/react";
import { Check, Search } from "lucide-react";
import { Button, Panel, Pill } from "../../ui";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

export type PlanZoneCard = {
  id: string;
  category: string;
  purpose: string;
  mount: string;
  footprint: { width: number; depth: number };
  where: string;
  suggested: boolean;
};

export type PlanCardData = {
  planId: Id<"plans">;
  status: string;
  spacing: string;
  zones: PlanZoneCard[];
  rejected: { zoneId: string; reason: string }[];
};

const MOUNT_LABEL: Record<string, string> = {
  floor: "floor",
  wall: "wall",
  surface: "on top",
  under: "under",
};

function size(zone: PlanZoneCard): string {
  const m = (value: number) => `${value.toFixed(value >= 1 ? 1 : 2)} m`;
  if (zone.mount === "wall") return `${m(zone.footprint.width)} wide`;
  return `${m(zone.footprint.width)} × ${m(zone.footprint.depth)}`;
}

// The reserved plan, shown before anything is searched. The user unticks
// pieces they do not want, then searches the rest. A confirmed card is frozen.
export function PlanCard({
  message,
  plan,
  disabled,
  prepare,
}: {
  message: { _id: Id<"messages">; content: string; answer?: string[] };
  plan: PlanCardData;
  disabled: boolean;
  prepare: () => Promise<void>;
}) {
  const confirm = useMutation(api.plans.confirm);
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirmed = message.answer !== undefined || plan.status !== "proposed";
  const kept = plan.zones.filter((zone) =>
    confirmed ? (message.answer ?? []).includes(zone.id) : !dropped.has(zone.id),
  );
  async function search() {
    if (busy || disabled || confirmed || kept.length === 0) return;
    setBusy(true);
    setError("");
    try {
      await prepare();
      await confirm({
        messageId: message._id,
        zoneIds: kept.map((zone) => zone.id),
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not start the search.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel tone="stone" className="shrink-0 rounded-tile p-3 text-[12.5px]">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h4 className="font-display text-sm font-medium text-ink">
          Your plan
        </h4>
        <span className="text-[11px] text-mute">
          {plan.zones.length} piece{plan.zones.length === 1 ? "" : "s"} ·{" "}
          {plan.spacing} spacing
        </span>
      </div>
      {message.content && (
        <p className="mb-2.5 leading-relaxed text-ink/90">{message.content}</p>
      )}
      <ul className="flex flex-col gap-1" aria-label="Planned pieces">
        {plan.zones.map((zone) => {
          const on = kept.some((item) => item.id === zone.id);
          return (
            <li key={zone.id}>
              <label
                className={`flex cursor-pointer items-start gap-2 rounded-ctrl px-2 py-1.5 transition-colors ${
                  on ? "bg-white/70" : "opacity-55"
                } ${confirmed ? "cursor-default" : "hover:bg-white"}`}
              >
                <input
                  type="checkbox"
                  className="mt-0.5 size-3.5 shrink-0 accent-teal"
                  checked={on}
                  disabled={confirmed || disabled || busy}
                  onChange={() =>
                    setDropped((current) => {
                      const next = new Set(current);
                      if (next.has(zone.id)) next.delete(zone.id);
                      else next.add(zone.id);
                      return next;
                    })
                  }
                  aria-label={`Keep ${zone.category}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium capitalize text-ink">
                      {zone.category}
                    </span>
                    {zone.suggested && <Pill tone="estimated">suggested</Pill>}
                    <Pill>{MOUNT_LABEL[zone.mount] ?? zone.mount}</Pill>
                  </span>
                  <span className="block text-[11px] text-mute">
                    {zone.where} · {size(zone)}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {plan.rejected.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-[11px] text-mute" aria-label="Did not fit">
          {plan.rejected.map((item) => (
            <li key={item.zoneId} className="flex gap-1.5 px-2">
              <span aria-hidden className="text-rust">✕</span>
              <span>{item.reason}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        {confirmed ? (
          <small className="flex items-center gap-1 text-[11px] text-teal-deep">
            <Check size={13} />
            Searching {kept.length} item{kept.length === 1 ? "" : "s"}
          </small>
        ) : (
          <>
            <small className="text-[11px] text-mute">
              Untick anything you do not want.
            </small>
            <Button
              size="sm"
              variant="primary"
              disabled={disabled || busy || kept.length === 0}
              onClick={() => void search()}
            >
              <Search size={14} />
              Search {kept.length} item{kept.length === 1 ? "" : "s"}
            </Button>
          </>
        )}
      </div>
      {error && (
        <p className="mt-2 text-xs leading-relaxed text-rust" role="alert">
          {error}
        </p>
      )}
    </Panel>
  );
}
