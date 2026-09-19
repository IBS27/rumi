import { stripHtml } from "./shopify";
import type { ImageRef } from "./images";

// Fetching the page ourselves is cheaper than a content API call and keeps the parts a
// content API strips: JSON-LD blocks, the storefront fingerprint, and image URLs.
// Retailers do block robots, so every caller needs a fallback.

export interface PageContent {
  url: string;
  title: string | null;
  html: string | null;
  text: string;
  images: ImageRef[];
}

const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml",
};

export function absolutize(candidate: string, base: string): string | null {
  try {
    return new URL(candidate, base).toString();
  } catch {
    return null;
  }
}

export function extractImages(html: string, base: string): ImageRef[] {
  const found: ImageRef[] = [];
  const push = (raw: string | undefined, alt: string | null = null) => {
    if (!raw) return;
    const url = absolutize(raw.trim().split(/\s+/)[0], base);
    if (url && /^https?:/.test(url)) found.push({ url, alt });
  };
  for (const match of html.matchAll(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi,
  ))
    push(match[1]);
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src =
      tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] ??
      tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1] ??
      tag.match(/\bsrcset=["']([^"',]+)/i)?.[1];
    push(src, tag.match(/\balt=["']([^"']*)["']/i)?.[1] ?? null);
  }
  const seen = new Set<string>();
  return found.filter((image) => {
    if (seen.has(image.url)) return false;
    seen.add(image.url);
    // Whole words only: "iconic-chair.jpg" is a product, "icon.png" is not.
    return (
      !/\.(svg|gif)(\?|$)/i.test(image.url) &&
      !/(^|[^a-z])(sprite|logo|icon|favicon)([^a-z]|$)/i.test(image.url)
    );
  });
}

// Script and style blocks are not prose: a JSON-LD blob would otherwise end up in the
// text the dimension parser reads.
export function htmlToText(html: string): string {
  return stripHtml(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])>/gi, "\n"),
  );
}

export function titleOf(html: string): string | null {
  return html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1].trim() ?? null;
}

export async function fetchPage(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PageContent | null> {
  try {
    const response = await fetchImpl(url, { headers: BROWSER_HEADERS });
    if (!response.ok) return null;
    const html = await response.text();
    if (!html) return null;
    return {
      url,
      title: titleOf(html),
      html,
      text: htmlToText(html),
      images: extractImages(html, url),
    };
  } catch {
    return null;
  }
}
