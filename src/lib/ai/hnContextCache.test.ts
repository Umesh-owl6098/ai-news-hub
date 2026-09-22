import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db/repository", () => ({
  getHnContextCache: vi.fn(),
  upsertHnContextCache: vi.fn(),
}));
vi.mock("@/lib/ai/hnContext", () => ({
  fetchHnDiscussionContext: vi.fn(),
}));

import { getHnContextCache, upsertHnContextCache } from "@/db/repository";
import { fetchHnDiscussionContext } from "@/lib/ai/hnContext";
import { isHnSourceKey, peekCachedHnContext, resolveHnSourceContext } from "./hnContextCache";

const mockedGetCache = vi.mocked(getHnContextCache);
const mockedUpsertCache = vi.mocked(upsertHnContextCache);
const mockedFetchContext = vi.mocked(fetchHnDiscussionContext);

const FRESH = new Date(); // just now
const STALE = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago, past the 24h TTL

afterEach(() => {
  vi.resetAllMocks();
});

describe("isHnSourceKey", () => {
  it("recognizes Hacker News source keys", () => {
    expect(isHnSourceKey("hn:12345")).toBe(true);
  });

  it("rejects non-HN source keys", () => {
    expect(isHnSourceKey("arxiv:2609.10540")).toBe(false);
    expect(isHnSourceKey("rss:openai:https://openai.com/x")).toBe(false);
    expect(isHnSourceKey("hn:not-a-number")).toBe(false);
  });
});

describe("resolveHnSourceContext", () => {
  it("does zero DB/network work for non-HN items", async () => {
    const result = await resolveHnSourceContext("rss:openai:https://openai.com/x", 1);
    expect(result).toBeUndefined();
    expect(mockedGetCache).not.toHaveBeenCalled();
    expect(mockedFetchContext).not.toHaveBeenCalled();
  });

  it("reuses a fresh has_context cache with ZERO Hacker News API calls", async () => {
    mockedGetCache.mockResolvedValue({ status: "has_context", normalizedContext: "cached text", fetchedAt: FRESH });
    const result = await resolveHnSourceContext("hn:1", 1);
    expect(result).toEqual({ label: "Hacker News discussion context", text: "cached text" });
    expect(mockedFetchContext).not.toHaveBeenCalled();
    expect(mockedUpsertCache).not.toHaveBeenCalled();
  });

  it("reuses a fresh no_context cache with ZERO Hacker News API calls (Step 16)", async () => {
    mockedGetCache.mockResolvedValue({ status: "no_context", normalizedContext: null, fetchedAt: FRESH });
    const result = await resolveHnSourceContext("hn:1", 1);
    expect(result).toBeUndefined();
    expect(mockedFetchContext).not.toHaveBeenCalled();
    expect(mockedUpsertCache).not.toHaveBeenCalled();
  });

  it("first enrichment (no cache): fetches, caches as has_context, and returns the fresh context", async () => {
    mockedGetCache.mockResolvedValue(null);
    mockedFetchContext.mockResolvedValue({
      label: "Hacker News discussion context",
      text: "fresh comments",
      commentRequestCount: 3,
    });
    const result = await resolveHnSourceContext("hn:1", 42);
    expect(result?.text).toBe("fresh comments");
    expect(mockedUpsertCache).toHaveBeenCalledWith(42, { status: "has_context", normalizedContext: "fresh comments" });
  });

  it("refreshes a stale cache when the live fetch succeeds with different content", async () => {
    mockedGetCache.mockResolvedValue({ status: "has_context", normalizedContext: "old text", fetchedAt: STALE });
    mockedFetchContext.mockResolvedValue({
      label: "Hacker News discussion context",
      text: "new text",
      commentRequestCount: 2,
    });
    const result = await resolveHnSourceContext("hn:1", 1);
    expect(result?.text).toBe("new text");
    expect(mockedUpsertCache).toHaveBeenCalledWith(1, { status: "has_context", normalizedContext: "new text" });
  });

  it("a stale-but-unchanged refresh still updates the cache row (fetchedAt), returning the same text", async () => {
    mockedGetCache.mockResolvedValue({ status: "has_context", normalizedContext: "same text", fetchedAt: STALE });
    mockedFetchContext.mockResolvedValue({
      label: "Hacker News discussion context",
      text: "same text",
      commentRequestCount: 2,
    });
    const result = await resolveHnSourceContext("hn:1", 1);
    expect(result?.text).toBe("same text");
    // The service always upserts on a successful refresh, unconditionally
    // updating fetchedAt to now — content equality is decided later, by
    // computeInputHash comparing the resulting sourceContext text, never here.
    expect(mockedUpsertCache).toHaveBeenCalledWith(1, { status: "has_context", normalizedContext: "same text" });
  });

  it("stale no_context cache + live fetch now finds usable content: persists has_context and returns it", async () => {
    // Comments can appear on a story after the fact — a stale no_context
    // row must not stay wrong forever; the next refresh past the TTL is a
    // real re-check, not just a formality.
    mockedGetCache.mockResolvedValue({ status: "no_context", normalizedContext: null, fetchedAt: STALE });
    mockedFetchContext.mockResolvedValue({
      label: "Hacker News discussion context",
      text: "a comment finally showed up",
      commentRequestCount: 1,
    });
    const result = await resolveHnSourceContext("hn:1", 1);
    expect(result?.text).toBe("a comment finally showed up");
    expect(mockedUpsertCache).toHaveBeenCalledWith(1, {
      status: "has_context",
      normalizedContext: "a comment finally showed up",
    });
  });

  it("stale cache + Hacker News outage (fetch throws): falls back to the stale cached value, persists nothing", async () => {
    mockedGetCache.mockResolvedValue({ status: "has_context", normalizedContext: "stale but valid", fetchedAt: STALE });
    mockedFetchContext.mockRejectedValue(new Error("network error"));
    const result = await resolveHnSourceContext("hn:1", 1);
    expect(result).toEqual({ label: "Hacker News discussion context", text: "stale but valid" });
    expect(mockedUpsertCache).not.toHaveBeenCalled();
  });

  it("stale no_context cache + Hacker News outage: falls back to no_context (undefined), persists nothing", async () => {
    mockedGetCache.mockResolvedValue({ status: "no_context", normalizedContext: null, fetchedAt: STALE });
    mockedFetchContext.mockRejectedValue(new Error("network error"));
    const result = await resolveHnSourceContext("hn:1", 1);
    expect(result).toBeUndefined();
    expect(mockedUpsertCache).not.toHaveBeenCalled();
  });

  it("stale cache + live fetch confirms no usable content: persists no_context and returns undefined — a confirmed answer overrides stale content, unlike an outage", async () => {
    mockedGetCache.mockResolvedValue({ status: "has_context", normalizedContext: "stale but valid", fetchedAt: STALE });
    mockedFetchContext.mockResolvedValue(null);
    const result = await resolveHnSourceContext("hn:1", 1);
    expect(result).toBeUndefined();
    expect(mockedUpsertCache).toHaveBeenCalledWith(1, { status: "no_context" });
  });

  it("no cache + Hacker News outage: gracefully returns undefined (baseline enrichment), persists nothing", async () => {
    mockedGetCache.mockResolvedValue(null);
    mockedFetchContext.mockRejectedValue(new Error("network error"));
    const result = await resolveHnSourceContext("hn:1", 1);
    expect(result).toBeUndefined();
    expect(mockedUpsertCache).not.toHaveBeenCalled();
  });

  it("no cache + live fetch confirms no usable content: persists no_context and returns undefined", async () => {
    mockedGetCache.mockResolvedValue(null);
    mockedFetchContext.mockResolvedValue(null);
    const result = await resolveHnSourceContext("hn:1", 1);
    expect(result).toBeUndefined();
    expect(mockedUpsertCache).toHaveBeenCalledWith(1, { status: "no_context" });
  });

  it("never throws even when the live fetch fails unexpectedly during refresh", async () => {
    mockedGetCache.mockResolvedValue({ status: "has_context", normalizedContext: "stale", fetchedAt: STALE });
    mockedFetchContext.mockImplementation(async () => {
      throw new Error("boom");
    });
    await expect(resolveHnSourceContext("hn:1", 1)).resolves.toEqual({
      label: "Hacker News discussion context",
      text: "stale",
    });
  });
});

describe("peekCachedHnContext — read-only, for dry-run/eligibility previews", () => {
  it("never calls the Hacker News API, only reads the cache", async () => {
    mockedGetCache.mockResolvedValue({ status: "has_context", normalizedContext: "cached", fetchedAt: STALE });
    const result = await peekCachedHnContext(1, "hn:1");
    expect(result).toEqual({ label: "Hacker News discussion context", text: "cached" });
    expect(mockedFetchContext).not.toHaveBeenCalled();
    expect(mockedUpsertCache).not.toHaveBeenCalled();
  });

  it("returns undefined for non-HN items without touching the cache", async () => {
    const result = await peekCachedHnContext(1, "arxiv:1234");
    expect(result).toBeUndefined();
    expect(mockedGetCache).not.toHaveBeenCalled();
  });

  it("returns undefined when there is no cache yet, without calling Hacker News", async () => {
    mockedGetCache.mockResolvedValue(null);
    const result = await peekCachedHnContext(1, "hn:1");
    expect(result).toBeUndefined();
    expect(mockedFetchContext).not.toHaveBeenCalled();
  });

  it("returns undefined for a cached no_context row — a confirmed empty result is not text to add to the prompt", async () => {
    mockedGetCache.mockResolvedValue({ status: "no_context", normalizedContext: null, fetchedAt: STALE });
    const result = await peekCachedHnContext(1, "hn:1");
    expect(result).toBeUndefined();
  });

  it("returns a stale cached value as-is (staleness is irrelevant for a read-only peek)", async () => {
    mockedGetCache.mockResolvedValue({ status: "has_context", normalizedContext: "old", fetchedAt: STALE });
    const result = await peekCachedHnContext(1, "hn:1");
    expect(result?.text).toBe("old");
  });
});
