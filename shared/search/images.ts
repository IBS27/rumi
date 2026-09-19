// A product photograph carries no scale and is never a source of dimensions. A
// dimension diagram is different: it is an image containing printed numbers. This
// shortlist decides which images are worth showing a model at all.

export interface ImageRef {
  url: string;
  alt?: string | null;
}

const DIAGRAM_WORDS =
  /(dimension|dimensions|dims?|spec|specification|measure|measurement|size|schematic|drawing|line.?art|scale)/i;

const SHORTLIST = 4;

export function diagramScore(image: ImageRef, index: number): number {
  const haystack = `${image.url} ${image.alt ?? ""}`;
  let score = 0;
  if (DIAGRAM_WORDS.test(haystack)) score += 3;
  // Retailers put the drawing after the hero shot, rarely first.
  if (index >= 1 && index <= 4) score += 1;
  return score;
}

export function shortlistDiagramImages(
  images: ImageRef[],
  limit = SHORTLIST,
): ImageRef[] {
  return images
    .map((image, index) => ({ image, index, score: diagramScore(image, index) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.image);
}

// A named drawing is worth one full-detail read on its own. Without that signal, two
// candidates are shown together rather than paying for the whole gallery.
export function diagramReadTargets(images: ImageRef[], limit = 2): ImageRef[] {
  const shortlist = shortlistDiagramImages(images);
  if (shortlist.length === 0) return [];
  return diagramScore(shortlist[0], 0) >= 3
    ? [shortlist[0]]
    : shortlist.slice(0, limit);
}

// Raw page markup is mostly site chrome: navigation, promotions, footer badges. A
// product image almost always carries part of the product slug in its URL, so that is
// the cheapest way to tell the gallery from the furniture of the page itself.
export function slugTokens(pageUrl: string): string[] {
  try {
    const last = new URL(pageUrl).pathname.split("/").filter(Boolean).pop() ?? "";
    return last
      .split(/[-_]+/)
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 3 && !/^\d+$/.test(token));
  } catch {
    return [];
  }
}

export function relevantImages(
  images: ImageRef[],
  pageUrl: string,
): ImageRef[] {
  const tokens = slugTokens(pageUrl);
  if (tokens.length === 0) return [];
  return images.filter((image) => {
    const haystack = `${image.url} ${image.alt ?? ""}`.toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  });
}
