import { afterEach, describe, expect, it, vi } from "vitest";

const { searchFeedItemsMock, vectorSearchFeedItemsMock, DatabaseError } = vi.hoisted(() => {
  class DatabaseError extends Error {}
  return {
    searchFeedItemsMock: vi.fn(),
    vectorSearchFeedItemsMock: vi.fn(),
    DatabaseError,
  };
});

vi.mock("@/db/repository", () => ({
  searchFeedItems: searchFeedItemsMock,
  vectorSearchFeedItems: vectorSearchFeedItemsMock,
  DatabaseError,
}));

const { semanticSearch } = await import("@/lib/ai/semanticSearch");

function throwingProvider() {
  return {
    name: "test",
    model: "test-model",
    embed: vi.fn(async () => {
      throw new Error("embed() must never be called for an empty query");
    }),
  };
}

describe("semanticSearch — empty query guard", () => {
  it("makes zero embedding calls for an empty query", async () => {
    const provider = throwingProvider();
    const results = await semanticSearch("", {}, 10, { provider });
    expect(results).toEqual([]);
    expect(provider.embed).not.toHaveBeenCalled();
    expect(vectorSearchFeedItemsMock).not.toHaveBeenCalled();
  });

  it("makes zero embedding calls for a whitespace-only query", async () => {
    const provider = throwingProvider();
    const results = await semanticSearch("   ", {}, 10, { provider });
    expect(results).toEqual([]);
    expect(provider.embed).not.toHaveBeenCalled();
  });
});

describe("semanticSearch — Step 27B AI egress guard (default, non-injected provider resolution)", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it("makes zero fetch calls for a real query when AI_EGRESS_DISABLED=1, even with valid-looking credentials — this is the exact Step 27 regression scenario", async () => {
    process.env.OPENAI_API_KEY = "sk-fake-valid-looking-key";
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
    process.env.AI_EGRESS_DISABLED = "1";

    // No `options.provider` — this exercises the real, default
    // `getEmbeddingProvider()` resolution path that production code
    // (lib/search.ts's performSearch) actually uses.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const results = await semanticSearch("agents", {}, 10);
    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vectorSearchFeedItemsMock).not.toHaveBeenCalled();
  });

  it("flag absent leaves the default provider resolution path free to run (would attempt a real call without a provider override)", async () => {
    delete process.env.AI_EGRESS_DISABLED;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_EMBEDDING_MODEL;

    // Nothing configured at all (distinct from egress-disabled) — the
    // pre-existing "not configured" no-op path, unaffected by this guard.
    const results = await semanticSearch("agents", {}, 10);
    expect(results).toEqual([]);
  });
});
