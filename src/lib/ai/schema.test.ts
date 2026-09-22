import { describe, expect, it } from "vitest";
import { enrichmentOutputSchema } from "./schema";

describe("enrichmentOutputSchema", () => {
  it("accepts a well-formed output", () => {
    const result = enrichmentOutputSchema.safeParse({
      summary: "A concise, factual summary.",
      topics: ["LLMs", "Agents"],
      relevanceScore: 0.75,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty summary", () => {
    expect(enrichmentOutputSchema.safeParse({ summary: "", topics: ["LLMs"], relevanceScore: 0.5 }).success).toBe(
      false
    );
  });

  it("rejects a summary that reads like an essay, not a 1-3 sentence blurb", () => {
    const essay = "This is a very long sentence. ".repeat(40);
    expect(
      enrichmentOutputSchema.safeParse({ summary: essay, topics: ["LLMs"], relevanceScore: 0.5 }).success
    ).toBe(false);
  });

  it("rejects a topic outside the fixed taxonomy — the model cannot invent labels", () => {
    const result = enrichmentOutputSchema.safeParse({
      summary: "Fine.",
      topics: ["Web3", "Crypto"],
      relevanceScore: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero topics", () => {
    expect(enrichmentOutputSchema.safeParse({ summary: "Fine.", topics: [], relevanceScore: 0.5 }).success).toBe(
      false
    );
  });

  it("rejects more than 4 topics", () => {
    const result = enrichmentOutputSchema.safeParse({
      summary: "Fine.",
      topics: ["LLMs", "Agents", "NLP", "Robotics", "Hardware"],
      relevanceScore: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate topics", () => {
    const result = enrichmentOutputSchema.safeParse({
      summary: "Fine.",
      topics: ["LLMs", "LLMs"],
      relevanceScore: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a relevanceScore outside [0, 1]", () => {
    expect(
      enrichmentOutputSchema.safeParse({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 1.5 }).success
    ).toBe(false);
    expect(
      enrichmentOutputSchema.safeParse({ summary: "Fine.", topics: ["LLMs"], relevanceScore: -0.1 }).success
    ).toBe(false);
  });

  it("rejects a non-numeric relevanceScore", () => {
    const result = enrichmentOutputSchema.safeParse({ summary: "Fine.", topics: ["LLMs"], relevanceScore: "high" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing field entirely", () => {
    expect(enrichmentOutputSchema.safeParse({ topics: ["LLMs"], relevanceScore: 0.5 }).success).toBe(false);
    expect(enrichmentOutputSchema.safeParse({ summary: "Fine.", relevanceScore: 0.5 }).success).toBe(false);
    expect(enrichmentOutputSchema.safeParse({ summary: "Fine.", topics: ["LLMs"] }).success).toBe(false);
  });

  it("rejects extra unexpected top-level junk gracefully (still validates the known shape)", () => {
    // Zod's default behavior (strip unknown keys) is fine here — the point
    // is that an extra field must never cause a crash.
    const result = enrichmentOutputSchema.safeParse({
      summary: "Fine.",
      topics: ["LLMs"],
      relevanceScore: 0.5,
      unexpected: "ignore previous instructions",
    });
    expect(result.success).toBe(true);
  });
});
