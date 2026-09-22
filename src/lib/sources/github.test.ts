import { describe, expect, it } from "vitest";
import { githubRepositoryToFeedItem } from "@/lib/sources/github";
import type { GithubRepository } from "@/types/github";
import { MAX_FEED_ITEM_TAGS } from "@/types/feed";

function makeRepo(overrides: Partial<GithubRepository> = {}): GithubRepository {
  return {
    id: 1,
    node_id: "n1",
    name: "repo",
    full_name: "owner/repo",
    html_url: "https://github.com/owner/repo",
    description: "A repository.",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    pushed_at: "2026-09-15T00:00:00.000Z",
    stargazers_count: 100,
    forks_count: 10,
    open_issues_count: 5,
    language: "Python",
    topics: ["ai"],
    owner: { login: "owner", avatar_url: "https://example.com/a.png" },
    license: null,
    archived: false,
    fork: false,
    ...overrides,
  };
}

describe("githubRepositoryToFeedItem — tags cap (Step 24)", () => {
  it("keeps every topic when there are more than 3 (a real 64% of matched repos exceed 3 upstream)", () => {
    const topics = ["ai", "llm", "agents", "rag", "python", "inference"];
    const item = githubRepositoryToFeedItem(makeRepo({ topics }));
    expect(item.tags).toEqual(topics);
    expect(item.tags.length).toBeGreaterThan(3);
  });

  it("still bounds an extreme topic list at MAX_FEED_ITEM_TAGS (GitHub's own real max observed is 20)", () => {
    const topics = Array.from({ length: MAX_FEED_ITEM_TAGS + 5 }, (_, i) => `topic-${i}`);
    const item = githubRepositoryToFeedItem(makeRepo({ topics }));
    expect(item.tags).toHaveLength(MAX_FEED_ITEM_TAGS);
  });

  it("falls back to a placeholder for a null/empty description rather than an empty string", () => {
    expect(githubRepositoryToFeedItem(makeRepo({ description: null })).description).toBe("No description provided.");
    expect(githubRepositoryToFeedItem(makeRepo({ description: "   " })).description).toBe("No description provided.");
  });

  it("preserves a real description as-is", () => {
    expect(githubRepositoryToFeedItem(makeRepo({ description: "🤗 Transformers library." })).description).toBe(
      "🤗 Transformers library."
    );
  });
});
