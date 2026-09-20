import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatMessage } from "../src/features/chat/ChatMessage";

const recommendation = {
  id: "sample-sofa",
  name: "Sample sofa",
  merchant: "Sample merchant",
  sourceUrl: "https://example.com/sofa",
  imageUrl: null,
  priceCents: 54766,
};

describe("product replies", () => {
  it("keeps existing commentary in closed notes while showing the card", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={{
          role: "assistant",
          status: "done",
          content: "Material caveat",
          recommendation,
        }}
      />,
    );
    expect(html).toContain("Sample sofa");
    expect(html).toContain("$547.66");
    expect(html).toMatch(
      /<details[^>]*><summary[^>]*>Rumi&#x27;s notes<\/summary>[\s\S]*<p[^>]*>Material caveat<\/p>[\s\S]*<\/details>/,
    );
    expect(html).not.toContain("<details open");
  });

  it("renders light Markdown as styled text, never raw markers", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={{
          role: "assistant",
          status: "done",
          content: [
            "### Design Signals",
            "**Style:** Modern and cozy with **eclectic** touches.",
            "- Vertical wood slats",
            "- Plush bedding",
            "Palette: neutral base with dark accents",
          ].join("\n"),
        }}
      />,
    );
    expect(html).not.toContain("###");
    expect(html).not.toContain("**");
    expect(html).toContain("<strong");
    expect(html).toContain("<li>Vertical wood slats</li>");
    expect(html).toMatch(/<span[^>]*>Palette:<\/span> neutral base/);
  });

  it("shows the image analysis as a closed note under the user's image", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={{
          role: "user",
          status: "done",
          content: "I uploaded an inspiration image.",
          imageUrl: "https://example.com/a.png",
          imageAnalysis: "Style: warm minimal.\nMaterials: oak, linen.",
        }}
      />,
    );
    expect(html).toContain("What Rumi saw");
    expect(html).toContain("warm minimal");
    expect(html).not.toContain("<details open");
  });

  it("does not stream duplicate product prose beside the card", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={{
          role: "assistant",
          status: "pending",
          content: "Duplicate description",
          recommendation,
        }}
      />,
    );
    expect(html).toContain("Sample sofa");
    expect(html).not.toContain("Duplicate description");
  });

  it("keeps errors visible even when a product was already found", () => {
    const html = renderToStaticMarkup(
      <ChatMessage
        message={{
          role: "assistant",
          status: "error",
          content: "Please retry",
          recommendation,
        }}
      />,
    );
    expect(html).toContain("Please retry");
    expect(html).not.toContain("<details");
  });

  it("shows ordinary assistant and user messages without collapsing them", () => {
    for (const role of ["assistant", "user"] as const) {
      const html = renderToStaticMarkup(
        <ChatMessage message={{ role, content: "Keep this text" }} />,
      );
      expect(html).toContain("Keep this text");
      expect(html).not.toContain("<details");
    }
  });
});
