import { describe, expect, it } from "vitest";
import { arxivEntryToFeedItem } from "@/lib/sources/arxiv";
import type { ArxivEntry } from "@/types/arxiv";
import { MAX_FEED_ITEM_TAGS } from "@/types/feed";

function makeEntry(overrides: Partial<ArxivEntry> = {}): ArxivEntry {
  return {
    id: "2609.17527",
    title: "A Paper",
    summary: "An abstract.",
    published: "2026-09-15T17:57:27.000Z",
    updated: "2026-09-15T17:57:27.000Z",
    authors: ["Author One"],
    categories: ["cs.AI"],
    abstractUrl: "https://arxiv.org/abs/2609.17527",
    ...overrides,
  };
}

describe("arxivEntryToFeedItem — tags cap (Step 24)", () => {
  it("keeps every category when there are more than 3 (a real ~12% of papers exceed 3 upstream)", () => {
    const categories = ["cs.MA", "cs.AI", "cs.NI", "cs.LG", "stat.ML"];
    const item = arxivEntryToFeedItem(makeEntry({ categories, primaryCategory: undefined }));
    expect(item.tags).toEqual(categories);
    expect(item.tags.length).toBeGreaterThan(3);
  });

  it("still bounds an extreme category list at MAX_FEED_ITEM_TAGS", () => {
    const categories = Array.from({ length: MAX_FEED_ITEM_TAGS + 5 }, (_, i) => `cat.${i}`);
    const item = arxivEntryToFeedItem(makeEntry({ categories, primaryCategory: undefined }));
    expect(item.tags).toHaveLength(MAX_FEED_ITEM_TAGS);
  });

  it("puts the primary category first without duplicating it", () => {
    const item = arxivEntryToFeedItem(makeEntry({ categories: ["cs.AI", "cs.LG"], primaryCategory: "cs.LG" }));
    expect(item.tags).toEqual(["cs.LG", "cs.AI"]);
  });

  it("preserves the full abstract (no length truncation applied here)", () => {
    const longSummary = "x".repeat(2000);
    const item = arxivEntryToFeedItem(makeEntry({ summary: longSummary }));
    expect(item.description).toBe(longSummary);
  });
});
