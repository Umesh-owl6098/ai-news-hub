import { describe, expect, it } from "vitest";
import { toSemanticDocument, type SemanticDocumentFeedItem } from "./semanticDocument";

function item(overrides: Partial<SemanticDocumentFeedItem> = {}): SemanticDocumentFeedItem {
  return {
    title: "A Title",
    summary: "A feed summary.",
    sourceType: "hackernews",
    sourceName: "Hacker News",
    tags: null,
    authors: null,
    repositoryFullName: null,
    ...overrides,
  };
}

describe("toSemanticDocument", () => {
  it("is deterministic: identical input produces identical output", () => {
    const input = item({ title: "Same Title", summary: "Same summary." });
    expect(toSemanticDocument(input)).toBe(toSemanticDocument(input));
    expect(toSemanticDocument(item({ title: "Same Title", summary: "Same summary." }))).toBe(
      toSemanticDocument(item({ title: "Same Title", summary: "Same summary." }))
    );
  });

  it("includes the title and feed summary when there is no enrichment", () => {
    const doc = toSemanticDocument(item({ title: "GPT-6 Astra launches", summary: "A new model from OpenAI." }));
    expect(doc).toContain("GPT-6 Astra launches");
    expect(doc).toContain("A new model from OpenAI.");
  });

  it("prefers the AI-generated summary over the raw feed summary when present", () => {
    const doc = toSemanticDocument(item({ summary: "Discussion thread on Hacker News." }), {
      summary: "A grounded AI summary of the actual discussion.",
      topics: null,
    });
    expect(doc).toContain("A grounded AI summary of the actual discussion.");
    expect(doc).not.toContain("Discussion thread on Hacker News.");
  });

  it("falls back to the raw feed summary when the enrichment summary is null", () => {
    const doc = toSemanticDocument(item({ summary: "Raw feed summary." }), { summary: null, topics: null });
    expect(doc).toContain("Raw feed summary.");
  });

  it("includes AI topic labels when present", () => {
    const doc = toSemanticDocument(item(), { summary: "x", topics: ["LLMs", "Agents"] });
    expect(doc).toContain("LLMs");
    expect(doc).toContain("Agents");
  });

  it("includes repository full name for GitHub items", () => {
    const doc = toSemanticDocument(item({ sourceType: "github", repositoryFullName: "openai/example" }));
    expect(doc).toContain("openai/example");
  });

  it("includes tags and authors when present", () => {
    const doc = toSemanticDocument(item({ tags: ["reasoning", "safety"], authors: ["Jane Doe"] }));
    expect(doc).toContain("reasoning");
    expect(doc).toContain("safety");
    expect(doc).toContain("Jane Doe");
  });

  it("includes publisher identity only for news items", () => {
    const newsDoc = toSemanticDocument(item({ sourceType: "news", sourceName: "OpenAI" }));
    expect(newsDoc).toContain("OpenAI");

    const hnDoc = toSemanticDocument(item({ sourceType: "hackernews", sourceName: "Hacker News" }));
    expect(hnDoc).not.toContain("Hacker News");

    const ghDoc = toSemanticDocument(item({ sourceType: "github", sourceName: "GitHub" }));
    expect(ghDoc).not.toContain("GitHub");
  });

  it("excludes scores, comment counts, timestamps, bookmark state, URLs, and database IDs by construction", () => {
    // These fields simply have no place in SemanticDocumentFeedItem's type
    // — this test documents that exclusion rather than probing runtime
    // behavior for something the type system already prevents.
    const doc = toSemanticDocument(item());
    expect(doc).not.toMatch(/https?:\/\//);
    expect(doc).not.toMatch(/^\d+$/);
  });

  it("is bounded in length even for a pathologically large input", () => {
    const hugeTags = Array.from({ length: 5000 }, (_, i) => `tag-${i}`);
    const doc = toSemanticDocument(item({ tags: hugeTags }));
    expect(doc.length).toBeLessThanOrEqual(4000);
  });

  it("normalizes by trimming whitespace", () => {
    const doc = toSemanticDocument(item({ title: "  Padded Title  ", summary: "  Padded summary.  " }));
    expect(doc.startsWith("Padded Title")).toBe(true);
    expect(doc).not.toContain("  Padded");
  });

  it("omits empty optional sections rather than emitting blank lines", () => {
    const doc = toSemanticDocument(item({ tags: [], authors: [], repositoryFullName: null }), { summary: "x", topics: [] });
    expect(doc).not.toContain("Tags:");
    expect(doc).not.toContain("Authors:");
    expect(doc).not.toContain("Repository:");
    expect(doc).not.toContain("Topics:");
  });
});
