// Color is scored, never filtered: a piece has to belong to the palette, not match it.
// Distances are measured in OKLab, which is perceptually even, so equal numbers mean
// equal visible difference.

interface Oklab {
  L: number;
  a: number;
  b: number;
}

const linear = (channel: number) =>
  channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);

export function hexToOklab(hex: string): Oklab {
  const value = hex.replace("#", "");
  const r = linear(parseInt(value.slice(0, 2), 16) / 255);
  const g = linear(parseInt(value.slice(2, 4), 16) / 255);
  const b = linear(parseInt(value.slice(4, 6), 16) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function deltaOk(left: string, right: string): number {
  const a = hexToOklab(left);
  const b = hexToOklab(right);
  return Math.sqrt((a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
}

// Black to white is a distance of 1. Half of that already reads as a different color,
// so it is the point where the score reaches zero.
const SCALE = 0.5;

// An unread finish is uncertainty, not literal grey. Keep it neutral in ranking so a
// missing color label cannot eliminate an otherwise strong product.
export const UNKNOWN_COLOR = "#9ca3af";

export function paletteScore(color: string, palette: string[]): number {
  if (palette.length === 0) return 0.5;
  if (color.toLowerCase() === UNKNOWN_COLOR) return 0.5;
  const closest = Math.min(...palette.map((entry) => deltaOk(color, entry)));
  return Math.max(0, 1 - closest / SCALE);
}

// Merchants name finishes rather than publishing hex values. The name is free and
// deterministic, so it is tried before asking a model to look at a photograph.
export const FINISH_COLORS: Record<string, string> = {
  "natural oak": "#c9a878",
  "white oak": "#d6bd97",
  "light oak": "#d2b183",
  oak: "#c19a6b",
  walnut: "#5c4033",
  "dark walnut": "#4a3328",
  cherry: "#7b3f28",
  mahogany: "#6b3226",
  teak: "#a67b4a",
  birch: "#e3d0ac",
  ash: "#d8cdb9",
  pine: "#dcb87f",
  maple: "#e0c49a",
  ebony: "#3a3335",
  rattan: "#c6a374",
  wicker: "#c2a578",
  bamboo: "#d6c08a",
  jute: "#c2b280",
  linen: "#e6ddc9",
  marble: "#eceae6",
  concrete: "#a8a8a3",
  "matte black": "#1c1c1c",
  black: "#1a1a1a",
  charcoal: "#36393b",
  graphite: "#4a4e52",
  slate: "#5c6670",
  grey: "#8b8d8f",
  gray: "#8b8d8f",
  greige: "#b5aca0",
  taupe: "#a89684",
  beige: "#d9c9b0",
  sand: "#d8c3a0",
  cream: "#efe6d4",
  ivory: "#f1e9da",
  "off-white": "#f0ece4",
  white: "#f6f6f4",
  silver: "#c8ccd0",
  chrome: "#cdd3d8",
  nickel: "#b5b8ba",
  brass: "#b5952f",
  gold: "#c9a227",
  bronze: "#8a6b3d",
  copper: "#b06b40",
  navy: "#20304f",
  blue: "#3a5f9e",
  sage: "#9caa8c",
  olive: "#77784f",
  forest: "#2f4a35",
  green: "#4b7a53",
  rust: "#9b4b28",
  terracotta: "#b5613c",
  burgundy: "#6a2434",
  blush: "#e0bdb3",
  pink: "#dda0ae",
  mustard: "#c9a02c",
  yellow: "#d8b13a",
  orange: "#cc6c2d",
  red: "#a83232",
  purple: "#6b4f86",
  lavender: "#b4a7cd",
};

// Longest name first, so "natural oak" is never read as "oak".
const FINISH_ENTRIES = Object.entries(FINISH_COLORS).sort(
  (a, b) => b[0].length - a[0].length,
);

export function colorFromWords(
  text: string,
): { hex: string; word: string } | null {
  if (!text.trim()) return null;
  const haystack = ` ${text.toLowerCase().replace(/[^a-z-]+/g, " ")} `;
  let best: { hex: string; word: string; at: number } | null = null;
  for (const [word, hex] of FINISH_ENTRIES) {
    const at = haystack.indexOf(` ${word} `);
    if (at === -1) continue;
    // Earliest mention wins; ties go to the longer name, which sorts first.
    if (!best || at < best.at) best = { hex, word, at };
  }
  return best ? { hex: best.hex, word: best.word } : null;
}
