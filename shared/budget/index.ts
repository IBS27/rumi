import type { ProductCandidate, RoomSnapshot } from "../contracts";
export function selectionTotal(
  room: RoomSnapshot,
  products: ProductCandidate[],
): number {
  return room.objects.reduce((total, object) => {
    if (object.owned || object.productId === null) return total;
    const product = products.find((item) => item.id === object.productId);
    if (!product) throw new Error(`Missing price for ${object.name}`);
    return total + product.priceCents;
  }, 0);
}
export const formatMoney = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
