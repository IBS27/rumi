import { describe, expect, it } from "bun:test";
import {
  colorFromWords,
  deltaOk,
  paletteScore,
} from "../shared/search/color";

describe("color proximity", () => {
  it("scores an identical color as a perfect match", () => {
    expect(deltaOk("#b78d60", "#b78d60")).toBe(0);
    expect(paletteScore("#b78d60", ["#b78d60"])).toBe(1);
  });

  it("scores a near shade higher than a distant one", () => {
    const near = paletteScore("#b78d60", ["#bb9268"]);
    const far = paletteScore("#b78d60", ["#1c3f8a"]);
    expect(near).toBeGreaterThan(0.85);
    expect(far).toBeLessThan(0.5);
    expect(near).toBeGreaterThan(far);
  });

  it("measures distance to the closest palette entry, not the first", () => {
    const palette = ["#1c3f8a", "#b78d60"];
    expect(paletteScore("#bb9268", palette)).toBeGreaterThan(0.85);
  });

  it("gives a neutral score when there is no palette", () => {
    expect(paletteScore("#b78d60", [])).toBe(0.5);
  });

  it("separates black from white", () => {
    expect(paletteScore("#000000", ["#ffffff"])).toBeLessThan(0.1);
  });
});

describe("finish names", () => {
  it("reads a color from a variant name", () => {
    expect(colorFromWords("Brushed Brass")?.word).toBe("brass");
    expect(colorFromWords("King / Cherry / White")?.word).toBe("cherry");
  });

  it("prefers the longer finish name", () => {
    expect(colorFromWords("Natural Oak")?.word).toBe("natural oak");
  });

  it("returns a usable hex", () => {
    expect(colorFromWords("Walnut")?.hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("returns nothing for a name without a color", () => {
    expect(colorFromWords("Model X-200")).toBeNull();
    expect(colorFromWords("")).toBeNull();
  });
});
