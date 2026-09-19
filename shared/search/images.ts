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

export function namesADiagram(image: ImageRef): boolean {
  return DIAGRAM_WORDS.test(`${image.url} ${image.alt ?? ""}`);
}

export function diagramScore(
  image: ImageRef,
  index: number,
  total: number,
): number {
  let score = 0;
  if (namesADiagram(image)) score += 3;
  // Retailers put the drawing after the hero shot, rarely first...
  if (index >= 1 && index <= 4) score += 1;
  // ...and often last of all, which is the best guess when nothing is named.
  if (total > 2 && index === total - 1) score += 2;
  return score;
}

export function shortlistDiagramImages(
  images: ImageRef[],
  limit = SHORTLIST,
): ImageRef[] {
  return images
    .map((image, index) => ({
      image,
      index,
      score: diagramScore(image, index, images.length),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.image);
}

// A named drawing is worth one full-detail read on its own. Without that signal, two
// candidates are shown together rather than paying for the whole gallery.
export function diagramReadTargets(images: ImageRef[], limit = 2): ImageRef[] {
  const shortlist = shortlistDiagramImages(images);
  if (shortlist.length === 0) return [];
  return namesADiagram(shortlist[0])
    ? [shortlist[0]]
    : shortlist.slice(0, limit);
}

// Raw page markup is mostly site chrome: navigation, promotions, footer badges. A
// product image almost always carries part of the product slug in its URL, so that is
// the cheapest way to tell the gallery from the furniture of the page itself.
export function slugTokens(pageUrl: string): string[] {
  try {
    const last =
      new URL(pageUrl).pathname.split("/").filter(Boolean).pop() ?? "";
    return last
      .split(/[-_]+/)
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 3 && !/^\d+$/.test(token));
  } catch {
    return [];
  }
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

export function relevantImages(
  images: ImageRef[],
  pageUrl: string,
): ImageRef[] {
  const tokens = slugTokens(pageUrl);
  if (tokens.length === 0) return [];
  return images.filter((image) => {
    // Whole words only: a page about a table must not adopt the site's own
    // "Tables_And_Benches" banner.
    const found = words(`${image.url} ${image.alt ?? ""}`);
    return tokens.some((token) => found.has(token));
  });
}
