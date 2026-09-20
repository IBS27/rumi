import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessage } from "../src/features/chat/ChatMessage";
import { productPlacementIssue } from "../shared/design/productPlacement";
import { sampleProducts } from "../shared/fixtures";
import type { ProductCandidate } from "../shared/contracts";

const product = sampleProducts[0];
function card(candidate: ProductCandidate, zoned = false, loaded = true) {
  return renderToStaticMarkup(
    <ChatMessage
      message={{
        role: "assistant",
        content: "",
        ...(zoned
          ? {
              zoneCards: [
                {
                  zoneId: "plant-spot",
                  category: "plant",
                  fits: "unknown" as const,
                  issues: [],
                  product: candidate,
                },
              ],
            }
          : { recommendation: candidate }),
      }}
      onPlaceProduct={async () => {}}
      productPlacementIssues={
        loaded ? { [candidate.id]: productPlacementIssue(candidate) } : {}
      }
    />,
  );
}
function placementButton(html: string) {
  return html.match(/<button\b[^>]*>Place in room<\/button>/)?.[0];
}

describe("product placement controls", () => {
  it("hides a plant with unknown dimensions in both chat card formats", () => {
    const plant: ProductCandidate = {
      ...product,
      name: "Big plant",
      category: "plant",
      measurement: {
        dimensions: null,
        source: "unknown",
        evidence: { kind: "none", detail: null },
      },
    };
    for (const zoned of [false, true]) {
      const html = card(plant, zoned);
      expect(placementButton(html)).toBeUndefined();
      expect(html).not.toContain("Big plant");
      expect(html).not.toContain("Dimensions are unknown.");
    }
  });

  it("allows placement once dimensions are known", () => {
    expect(placementButton(card(product))).toBeDefined();
    expect(placementButton(card(product))).not.toContain('disabled=""');
  });

  it("blocks unavailable products and missing catalog details", () => {
    const unavailable: ProductCandidate = {
      ...product,
      availability: "unavailable",
    };
    expect(placementButton(card(unavailable))).toBeUndefined();
    expect(card(unavailable)).not.toContain("View product");
    expect(placementButton(card(product, false, false))).toBeUndefined();
    expect(card(product, false, false)).not.toContain("View product");
  });
});
