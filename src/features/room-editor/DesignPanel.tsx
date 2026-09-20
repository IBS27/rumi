import { useState } from "react";
import { ExternalLink, Plus, ShoppingBag, X } from "lucide-react";
import { productPlacementIssue } from "../../../shared/design/productPlacement";
import type { DesignState } from "../../../shared/design/state";
import type { RoomObject } from "../../../shared/contracts";
import { formatMoney, selectionTotal } from "../../../shared/budget";
import {
  Button,
  FloatingPanel,
  Heading,
  Muted,
  Notice,
  Pill,
  Segmented,
} from "../../ui";

export function DesignPanel({
  state,
  busy,
  onClose,
  onPlace,
  onPlaceAll,
  onSelect,
  onRetry,
}: {
  state: DesignState;
  busy: boolean;
  onClose: () => void;
  onPlace: (id: string, zoneId?: string) => Promise<void>;
  onPlaceAll: () => Promise<void>;
  onSelect: (id: string) => void;
  onRetry: (id: string) => Promise<unknown>;
}) {
  const [tab, setTab] = useState<"found" | "selected">("found");
  const [error, setError] = useState("");
  const selected = state.room.objects.filter(
    (item) => item.productId && !item.owned,
  );
  const missing = selected.some(
    (item) => !state.products.some((product) => product.id === item.productId),
  );
  const total = missing ? null : selectionTotal(state.room, state.products);
  const remaining =
    total !== null && state.brief.budgetCents
      ? state.brief.budgetCents - total
      : null;
  const recommendations = state.recommendations.filter(
    ({ product }) => product.measurement.dimensions !== null,
  );
  const unplaced = recommendations.filter(
    ({ product, zone }) =>
      !selected.some((object) =>
        zone ? object.zoneId === zone.id : object.productId === product.id,
      ),
  );
  const hasUnplaceable = unplaced.some(({ product }) =>
    productPlacementIssue(product),
  );
  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "This change could not be applied.",
      );
    }
  };
  function assetStatus(object: RoomObject) {
    const product = state.products.find((item) => item.id === object.productId);
    return state.assets.find(
      (item) => item.id === (product?.assetId ?? object.assetId),
    );
  }
  return (
    <FloatingPanel
      aria-label="Room products"
      className="left-4 top-28 bottom-4 flex w-[292px] max-w-[calc(100%-32px)] flex-col !p-0 lg:top-16"
    >
      <div className="border-b border-line p-4">
        <div className="flex items-center justify-between gap-2">
          <Heading className="flex items-center gap-2 text-lg">
            <ShoppingBag size={18} /> Your design
          </Heading>
          <Button
            size="sm"
            variant="quiet"
            onClick={onClose}
            aria-label="Close products"
          >
            <X />
          </Button>
        </div>
        <div className="mt-3 flex items-baseline justify-between gap-2">
          <span className="font-display text-2xl">
            {total === null ? "Price unavailable" : formatMoney(total)}
          </span>
          <Muted className="text-xs">{selected.length} selected</Muted>
        </div>
        {remaining !== null && (
          <p
            className={`mt-1 text-xs ${remaining < 0 ? "text-rust" : "text-teal-deep"}`}
          >
            {remaining < 0
              ? `${formatMoney(-remaining)} over budget`
              : `${formatMoney(remaining)} remaining`}{" "}
            of {formatMoney(state.brief.budgetCents)}
          </p>
        )}
        <Muted className="mt-1 block text-[11px]">
          Item subtotal. Shipping and tax are not included.
        </Muted>
        <Segmented
          className="mt-3 w-full"
          label="Product list"
          value={tab}
          onChange={setTab}
          options={[
            { value: "found", label: "Found products" },
            { value: "selected", label: "In your room" },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {error && (
          <Notice tone="error" onDismiss={() => setError("")}>
            {error}
          </Notice>
        )}
        {tab === "found" &&
          recommendations.map(({ product, zone }) => {
            const placed = selected.find((item) =>
              zone ? item.zoneId === zone.id : item.productId === product.id,
            );
            const dimensions = product.measurement.dimensions;
            const placementIssue = productPlacementIssue(product);
            return (
              <div
                key={`${zone?.id ?? ""}:${product.id}`}
                className="border-b border-line pb-3 last:border-0"
              >
                <div className="flex gap-2.5">
                  {product.imageUrl && (
                    <img
                      src={product.imageUrl}
                      alt=""
                      className="size-16 shrink-0 rounded-tile bg-white object-contain"
                    />
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug">
                      {product.name}
                    </p>
                    <p className="mt-1 text-sm">
                      {formatMoney(product.priceCents)}
                    </p>
                    <Muted className="block text-[11px]">
                      {product.merchant}
                    </Muted>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {product.synthetic && <Pill>sample</Pill>}
                  <Pill
                    tone={
                      product.measurement.source === "confirmed"
                        ? "ok"
                        : "estimated"
                    }
                  >
                    {product.measurement.source === "confirmed"
                      ? "confirmed size"
                      : "estimated size"}
                  </Pill>
                  {zone && (
                    <Pill>
                      {zone.mount === "surface" ? "on a surface" : zone.mount}
                    </Pill>
                  )}
                </div>
                <Muted className="mt-1 block text-[11px]">
                  {dimensions
                    ? `${dimensions.width.toFixed(2)} × ${dimensions.depth.toFixed(2)} × ${dimensions.height.toFixed(2)} m`
                    : "Dimensions unknown"}
                </Muted>
                {!placed && placementIssue && (
                  <Muted className="mt-1 block text-xs">{placementIssue}</Muted>
                )}
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant={placed ? "soft" : "primary"}
                    disabled={busy || (!placed && Boolean(placementIssue))}
                    onClick={() =>
                      placed
                        ? onSelect(placed.id)
                        : void run(() => onPlace(product.id, zone?.id))
                    }
                  >
                    {placed ? (
                      "Select in room"
                    ) : (
                      <>
                        <Plus /> Place in room
                      </>
                    )}
                  </Button>
                  {!product.synthetic && (
                    <a
                      className="inline-flex items-center gap-1 text-xs text-teal-deep"
                      href={product.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Store <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        {tab === "found" && !recommendations.length && (
          <Muted className="block text-sm">
            Ask Rumi to find products. Your recommendations will appear here.
          </Muted>
        )}
        {tab === "selected" &&
          selected.map((object) => {
            const product = state.products.find(
              (item) => item.id === object.productId,
            );
            const asset = assetStatus(object);
            return (
              <div
                key={object.id}
                className="border-b border-line pb-3 last:border-0"
              >
                <Button
                  variant="quiet"
                  size="sm"
                  className="w-full justify-between whitespace-normal text-left"
                  onClick={() => onSelect(object.id)}
                >
                  <span>{object.name}</span>
                  <span>
                    {product ? formatMoney(product.priceCents) : "Unpriced"}
                  </span>
                </Button>
                <div className="mt-1 flex flex-wrap gap-1">
                  {object.productLocked && (
                    <Pill tone="locked">product kept</Pill>
                  )}
                  {object.locked && <Pill tone="locked">position locked</Pill>}
                  <Pill tone="estimated">
                    {asset?.status === "ready"
                      ? "approximate model"
                      : asset?.status === "pending"
                        ? "preparing model"
                        : "size preview"}
                  </Pill>
                </div>
                {asset?.status === "failed" && !product?.synthetic && (
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={busy}
                    onClick={() => void run(() => onRetry(object.productId!))}
                  >
                    Retry product model
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={busy}
                  className="mt-1"
                  onClick={() => void run(() => onPlace(object.productId!))}
                >
                  <Plus /> Add another
                </Button>
              </div>
            );
          })}
        {tab === "selected" && !selected.length && (
          <Muted className="block text-sm">
            Place a product to start your selection. Existing possessions cost
            nothing in this subtotal.
          </Muted>
        )}
      </div>
      {tab === "found" && unplaced.length > 1 && (
        <div className="border-t border-line p-3">
          <Button
            className="w-full"
            variant="primary"
            disabled={busy || hasUnplaceable}
            onClick={() => void run(onPlaceAll)}
          >
            Place {unplaced.length} products
          </Button>
          <Muted className="mt-1 block text-[11px]">
            {hasUnplaceable
              ? "Some products cannot be placed yet. Place available products individually."
              : "Checks the complete layout and budget before applying."}
          </Muted>
        </div>
      )}
    </FloatingPanel>
  );
}
