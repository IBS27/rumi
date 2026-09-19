import { z } from "zod";

// Every Shopify storefront publishes its own catalog as JSON. Those are the merchant's
// numbers, so they replace a model reading a page for price, variants and stock.
// Dimensions are not exposed there, so the dimension cascade still runs.

const variantSchema = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  price: z.union([z.string(), z.number()]),
  available: z.boolean().optional(),
  sku: z.string().nullable().optional(),
});

const rawProductSchema = z.object({
  title: z.string(),
  handle: z.string().optional(),
  vendor: z.string().optional(),
  product_type: z.string().optional(),
  tags: z.union([z.array(z.string()), z.string()]).optional(),
  body_html: z.string().nullable().optional(),
  images: z
    .array(
      z.object({
        src: z.string(),
        alt: z.string().nullable().optional(),
      }),
    )
    .optional(),
  variants: z.array(variantSchema).optional(),
});

const payloadSchema = z.union([
  z.object({ products: z.array(rawProductSchema).min(1) }),
  z.object({ product: rawProductSchema }),
  rawProductSchema,
]);

export interface ShopifyVariant {
  id: string;
  title: string;
  priceCents: number;
  available: boolean;
  sku: string | null;
}

export interface ShopifyProduct {
  title: string;
  handle: string | null;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  bodyText: string;
  images: { url: string; alt: string | null }[];
  variants: ShopifyVariant[];
}

export function isShopify(html: string): boolean {
  return /cdn\.shopify\.com|Shopify\.shop|shopify-section/i.test(html);
}

export function productJsonUrl(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    const handle = url.pathname.match(/\/products\/([^/?#]+)/);
    if (!handle) return null;
    return `${url.origin}/products/${handle[1].replace(/\.json$/, "")}.json`;
  } catch {
    return null;
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, code: string) =>
      String.fromCharCode(Number(code)),
    )
    .replace(/[ \t]+/g, " ")
    .trim();
}

export function mapShopifyProduct(payload: unknown): ShopifyProduct | null {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const data = parsed.data;
  const raw =
    "products" in data
      ? data.products[0]
      : "product" in data
        ? data.product
        : data;
  const tags = Array.isArray(raw.tags)
    ? raw.tags
    : typeof raw.tags === "string"
      ? raw.tags.split(",").map((tag) => tag.trim())
      : [];
  return {
    title: raw.title,
    handle: raw.handle ?? null,
    vendor: raw.vendor ?? null,
    productType: raw.product_type ?? null,
    tags: tags.filter(Boolean),
    bodyText: stripHtml(raw.body_html ?? ""),
    images: (raw.images ?? []).map((image) => ({
      url: image.src,
      alt: image.alt ?? null,
    })),
    variants: (raw.variants ?? []).map((variant) => ({
      id: String(variant.id),
      title: variant.title,
      priceCents: Math.round(Number(variant.price) * 100),
      available: variant.available ?? true,
      sku: variant.sku ?? null,
    })),
  };
}
