import { describe, expect, it } from "bun:test";
import { choiceListToCard } from "../shared/chat/choices";

describe("text choice lists become option cards", () => {
  it("reads a numbered list that follows a question", () => {
    const card = choiceListToCard(
      [
        "Great, a bedroom it is.",
        "",
        "Which style direction appeals to you?",
        "1. **Scandinavian** – light woods, calm tones",
        "2. Japandi",
        "3) Industrial",
        "4. Mid-century modern",
      ].join("\n"),
    );
    expect(card).toEqual({
      question: "Which style direction appeals to you?",
      options: [
        "Scandinavian – light woods, calm tones",
        "Japandi",
        "Industrial",
        "Mid-century modern",
      ],
      multiSelect: false,
      intro: "Great, a bedroom it is.",
    });
  });

  it("accepts bullets and a short closing line, and caps at four options", () => {
    const card = choiceListToCard(
      [
        "Do you have a budget for this room?",
        "- Under $1,500",
        "- $1,500–4,000",
        "- $4,000–8,000",
        "- No budget yet",
        "- Something else",
        "Let me know which fits.",
      ].join("\n"),
    );
    expect(card?.question).toBe("Do you have a budget for this room?");
    expect(card?.options).toHaveLength(4);
    expect(card?.options[0]).toBe("Under $1,500");
  });

  it("uses a trailing question when the list comes first", () => {
    const card = choiceListToCard(
      ["a) Bedroom", "b) Living room", "c) Home office", "Which is it?"].join("\n"),
    );
    expect(card?.question).toBe("Which is it?");
    expect(card?.options).toEqual(["Bedroom", "Living room", "Home office"]);
  });

  it("handles the real reply: intro, question with lead-in, list, long closing line", () => {
    const card = choiceListToCard(
      [
        "The inspiration image suggests a contemporary aesthetic with eclectic touches and a cozy, functional design. Let's build on that!",
        "",
        "What is this room for? Here are some options to choose from:",
        "",
        "1. Bedroom",
        "2. Living room",
        "3. Home office",
        "4. Multi-purpose",
        "",
        "Please let me know which one fits best or feel free to suggest another purpose!",
      ].join("\n"),
    );
    expect(card?.question).toBe("What is this room for?");
    expect(card?.options).toEqual(["Bedroom", "Living room", "Home office", "Multi-purpose"]);
    expect(card?.multiSelect).toBe(false);
    expect(card?.intro).toContain("contemporary aesthetic");
  });

  it("infers multi-select from the wording", () => {
    const card = choiceListToCard(
      ["Which of these styles would you like to blend? Pick all that apply.", "- Scandinavian", "- Japandi", "- Industrial"].join("\n"),
    );
    expect(card?.multiSelect).toBe(true);
    expect(card?.question).toBe("Which of these styles would you like to blend?");
  });

  it("leaves explanations, long items, and non-lists alone", () => {
    expect(choiceListToCard("Here is what I found for your room.")).toBeNull();
    expect(
      choiceListToCard(
        [
          "I reserved three zones:",
          "1. The bed sits against the north wall with 0.75 m of clearance on each side so you can make it easily.",
          "2. The nightstand stands beside it, inside the bed's clearance.",
          "3. The rug lies under both.",
        ].join("\n"),
      ),
    ).toBeNull();
    expect(choiceListToCard("1. Only one\nWhich?")).toBeNull();
  });
});
