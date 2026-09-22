import { describe, expect, it } from "vitest";
import { computeInputHash } from "./hash";
import type { ArticleEnrichmentInput } from "./types";

const base: ArticleEnrichmentInput = {
  title: "New agent framework released",
  sourceName: "Hacker News",
  summary: "A team released an open source framework for building LLM agents.",
  authors: ["Jane Doe"],
  tags: ["Hacker News"],
};

describe("computeInputHash", () => {
  it("is deterministic for the same input and prompt version", () => {
    expect(computeInputHash(base, "ai-news-v1")).toBe(computeInputHash({ ...base }, "ai-news-v1"));
  });

  it("changes when the title changes", () => {
    expect(computeInputHash(base, "ai-news-v1")).not.toBe(
      computeInputHash({ ...base, title: "A different title" }, "ai-news-v1")
    );
  });

  it("changes when the summary changes", () => {
    expect(computeInputHash(base, "ai-news-v1")).not.toBe(
      computeInputHash({ ...base, summary: "A different summary." }, "ai-news-v1")
    );
  });

  it("changes when tags change", () => {
    expect(computeInputHash(base, "ai-news-v1")).not.toBe(
      computeInputHash({ ...base, tags: ["Different"] }, "ai-news-v1")
    );
  });

  it("changes when authors change", () => {
    expect(computeInputHash(base, "ai-news-v1")).not.toBe(
      computeInputHash({ ...base, authors: ["Someone Else"] }, "ai-news-v1")
    );
  });

  it("changes when repository/owner/language fields change", () => {
    const withRepo: ArticleEnrichmentInput = { ...base, repositoryFullName: "owner/repo", owner: "owner" };
    expect(computeInputHash(withRepo, "ai-news-v1")).not.toBe(
      computeInputHash({ ...withRepo, owner: "someone-else" }, "ai-news-v1")
    );
  });

  it("changes when the prompt version changes — a prompt edit invalidates the whole cache", () => {
    expect(computeInputHash(base, "ai-news-v1")).not.toBe(computeInputHash(base, "ai-news-v2"));
  });

  it("treats undefined and an empty array the same way for optional list fields", () => {
    const withUndefined: ArticleEnrichmentInput = { ...base, tags: undefined };
    const withEmpty: ArticleEnrichmentInput = { ...base, tags: [] };
    expect(computeInputHash(withUndefined, "ai-news-v1")).toBe(computeInputHash(withEmpty, "ai-news-v1"));
  });

  // --- Step 13: sourceContext backward compatibility ---
  //
  // These lock in that adding sourceContext support could never silently
  // invalidate every baseline hash already stored from Steps 9-12 — the
  // golden value below was computed from the exact pre-Step-13 hash
  // function against this same fixture.
  it("computes the same hash as before sourceContext existed, when sourceContext is absent (regression lock)", () => {
    expect(computeInputHash(base, "ai-news-v1")).toBe(
      "931e74302379f101a65cec9915a1d9a16dfab933b182bf9a5845fb341cfa0ed4"
    );
  });

  it("is unaffected by an explicitly undefined sourceContext", () => {
    const withUndefinedContext: ArticleEnrichmentInput = { ...base, sourceContext: undefined };
    expect(computeInputHash(withUndefinedContext, "ai-news-v1")).toBe(computeInputHash(base, "ai-news-v1"));
  });

  it("changes when sourceContext is added — augmented input must never collide with the baseline cache entry", () => {
    const withContext: ArticleEnrichmentInput = {
      ...base,
      sourceContext: { label: "Hacker News discussion context", text: "Some commenters noted X." },
    };
    expect(computeInputHash(withContext, "ai-news-v1")).not.toBe(computeInputHash(base, "ai-news-v1"));
  });

  it("changes when sourceContext text changes, with everything else held fixed", () => {
    const a: ArticleEnrichmentInput = { ...base, sourceContext: { label: "X", text: "one" } };
    const b: ArticleEnrichmentInput = { ...base, sourceContext: { label: "X", text: "two" } };
    expect(computeInputHash(a, "ai-news-v1")).not.toBe(computeInputHash(b, "ai-news-v1"));
  });
});
