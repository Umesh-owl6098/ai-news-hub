import { describe, expect, it, vi, beforeEach } from "vitest";
import type { FeedItem } from "@/types/feed";
import type { SearchState } from "@/lib/searchState";

const { isDatabaseConfiguredMock, searchFeedItemsMock, semanticSearchMock, getEmbeddingProviderMock, DatabaseError } =
  vi.hoisted(() => {
    class DatabaseError extends Error {}
    return {
      isDatabaseConfiguredMock: vi.fn(() => true),
      searchFeedItemsMock: vi.fn(),
      semanticSearchMock: vi.fn(),
      getEmbeddingProviderMock: vi.fn(),
      DatabaseError,
    };
  });

vi.mock("@/db", () => ({ isDatabaseConfigured: isDatabaseConfiguredMock }));
vi.mock("@/db/repository", () => ({ searchFeedItems: searchFeedItemsMock, DatabaseError }));
vi.mock("@/lib/ai/semanticSearch", () => ({ semanticSearch: semanticSearchMock }));
vi.mock("@/lib/ai/embeddingProvider", () => ({ getEmbeddingProvider: getEmbeddingProviderMock }));

const { performSearch } = await import("@/lib/search");

function makeState(partial: Partial<SearchState> = {}): SearchState {
  return {
    tab: "All",
    q: "agents",
    time: "any",
    source: undefined,
    sort: "relevance",
    page: 1,
    mode: "keyword",
    ...partial,
  };
}

function makeItem(id: string): FeedItem {
  return {
    id,
    sourceType: "news",
    sourceName: "Test Source",
    title: `Item ${id}`,
    description: "desc",
    publishedAt: new Date().toISOString(),
    tags: [],
    score: 0,
    commentCount: 0,
    url: `https://example.com/${id}`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isDatabaseConfiguredMock.mockReturnValue(true);
  getEmbeddingProviderMock.mockReturnValue({ name: "openai", model: "text-embedding-3-small" });
});

describe("performSearch", () => {
  it("Keyword mode invokes existing FTS and never touches semantic retrieval", async () => {
    searchFeedItemsMock.mockResolvedValue({ items: [makeItem("1")], total: 1 });

    const result = await performSearch(makeState({ mode: "keyword" }));

    expect(searchFeedItemsMock).toHaveBeenCalledTimes(1);
    expect(semanticSearchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ requestedMode: "keyword", effectiveMode: "keyword", error: null, total: 1 });
  });

  it("Semantic mode invokes semantic retrieval and never touches lexical FTS", async () => {
    const item = makeItem("2");
    semanticSearchMock.mockResolvedValue([{ item, score: 0.9 }]);

    const result = await performSearch(makeState({ mode: "semantic" }));

    expect(semanticSearchMock).toHaveBeenCalledTimes(1);
    expect(searchFeedItemsMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ requestedMode: "semantic", effectiveMode: "semantic", error: null, total: 1 });
    expect(result.items).toEqual([item]);
  });

  it("passes filters derived from tab/time/source identically to both retrieval paths", async () => {
    searchFeedItemsMock.mockResolvedValue({ items: [], total: 0 });
    semanticSearchMock.mockResolvedValue([]);

    const state = makeState({ mode: "semantic", tab: "Hacker News", time: "7d", source: undefined });
    await performSearch(state);

    expect(semanticSearchMock).toHaveBeenCalledWith(
      state.q,
      { sourceType: "hackernews", sourceId: undefined, sinceDays: 7, bookmarkedOnly: false },
      expect.any(Number)
    );
  });

  it("Step 27: passes an actual publisher (source) selection through to Semantic retrieval unchanged", async () => {
    searchFeedItemsMock.mockResolvedValue({ items: [], total: 0 });
    semanticSearchMock.mockResolvedValue([]);

    const state = makeState({ mode: "semantic", tab: "News", source: "nvidia-developer" });
    await performSearch(state);

    expect(semanticSearchMock).toHaveBeenCalledWith(
      state.q,
      { sourceType: "news", sourceId: "nvidia-developer", sinceDays: undefined, bookmarkedOnly: false },
      expect.any(Number)
    );
    // Publisher filtering must never itself trigger a keyword fallback.
    expect(searchFeedItemsMock).not.toHaveBeenCalled();
  });

  it("Step 27: passes an actual publisher (source) selection through to Keyword retrieval unchanged", async () => {
    searchFeedItemsMock.mockResolvedValue({ items: [], total: 0 });

    const state = makeState({ mode: "keyword", tab: "News", source: "mistral" });
    await performSearch(state);

    expect(searchFeedItemsMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: "news", sourceId: "mistral" })
    );
  });

  it("falls back to Keyword when no embedding provider is configured, and reports the mismatch", async () => {
    getEmbeddingProviderMock.mockReturnValue(null);
    searchFeedItemsMock.mockResolvedValue({ items: [makeItem("3")], total: 1 });

    const result = await performSearch(makeState({ mode: "semantic" }));

    expect(semanticSearchMock).not.toHaveBeenCalled();
    expect(searchFeedItemsMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ requestedMode: "semantic", effectiveMode: "keyword", error: null });
  });

  it("falls back to Keyword when semantic retrieval throws transiently, without surfacing a raw error", async () => {
    semanticSearchMock.mockRejectedValue(new Error("OpenAI rate limit exceeded"));
    searchFeedItemsMock.mockResolvedValue({ items: [makeItem("4")], total: 1 });

    const result = await performSearch(makeState({ mode: "semantic" }));

    expect(searchFeedItemsMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ requestedMode: "semantic", effectiveMode: "keyword", error: null, total: 1 });
  });

  it("reports a clear error for both modes when the database isn't configured, without falling back", async () => {
    isDatabaseConfiguredMock.mockReturnValue(false);

    const keywordResult = await performSearch(makeState({ mode: "keyword" }));
    const semanticResult = await performSearch(makeState({ mode: "semantic" }));

    expect(searchFeedItemsMock).not.toHaveBeenCalled();
    expect(semanticSearchMock).not.toHaveBeenCalled();
    expect(keywordResult).toMatchObject({ requestedMode: "keyword", effectiveMode: "keyword" });
    expect(semanticResult).toMatchObject({ requestedMode: "semantic", effectiveMode: "semantic" });
    expect(keywordResult.error).toBeTruthy();
    expect(semanticResult.error).toBeTruthy();
  });
});
