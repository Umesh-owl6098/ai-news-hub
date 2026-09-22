import { describe, expect, it } from "vitest";
import { hackerNewsItemToFeedItem } from "@/lib/sources/hackernews";
import type { HackerNewsItem } from "@/types/hackernews";

/**
 * V1 verification-closure — the exhaustive v1 verification found that,
 * unlike arxiv.ts/github.ts/rss.ts, `hackerNewsItemToFeedItem` (the real
 * raw-HN-to-FeedItem conversion) had no dedicated unit test: the only
 * existing coverage was refreshService.integration.test.ts injecting an
 * already-normalized FeedItem via a mocked `fetchHackerNews`, which
 * bypasses this function entirely. These tests call the real function
 * directly, with no network request.
 */

function makeItem(overrides: Partial<HackerNewsItem> = {}): HackerNewsItem {
  return {
    id: 49789356,
    type: "story",
    by: "alice",
    time: 1758500000, // a fixed, real-shaped Unix timestamp (seconds)
    title: "Show HN: A real title",
    url: "https://example.com/article",
    score: 42,
    descendants: 7,
    ...overrides,
  };
}

describe("hackerNewsItemToFeedItem — stable identity and source metadata", () => {
  it("prefixes the id with 'hn:' so it can never collide with another source", () => {
    const feedItem = hackerNewsItemToFeedItem(makeItem({ id: 12345 }));
    expect(feedItem.id).toBe("hn:12345");
  });

  it("always sets sourceType to hackernews", () => {
    const feedItem = hackerNewsItemToFeedItem(makeItem());
    expect(feedItem.sourceType).toBe("hackernews");
  });

  it("always tags the item exactly ['Hacker News']", () => {
    const feedItem = hackerNewsItemToFeedItem(makeItem());
    expect(feedItem.tags).toEqual(["Hacker News"]);
  });

  it("always sets discussionUrl to the canonical HN item page, regardless of the story's own url", () => {
    const feedItem = hackerNewsItemToFeedItem(makeItem({ id: 999, url: "https://external.example/post" }));
    expect(feedItem.discussionUrl).toBe("https://news.ycombinator.com/item?id=999");
  });
});

describe("hackerNewsItemToFeedItem — author attribution", () => {
  it("includes the submitter in sourceName when 'by' is present", () => {
    const feedItem = hackerNewsItemToFeedItem(makeItem({ by: "pg" }));
    expect(feedItem.sourceName).toBe("Hacker News · pg");
  });

  it("falls back to plain 'Hacker News' when 'by' is missing", () => {
    const feedItem = hackerNewsItemToFeedItem(makeItem({ by: undefined }));
    expect(feedItem.sourceName).toBe("Hacker News");
  });
});

describe("hackerNewsItemToFeedItem — title", () => {
  it("uses the real title when present", () => {
    const feedItem = hackerNewsItemToFeedItem(makeItem({ title: "A specific real title" }));
    expect(feedItem.title).toBe("A specific real title");
  });

  it("falls back to a placeholder when title is missing", () => {
    const feedItem = hackerNewsItemToFeedItem(makeItem({ title: undefined }));
    expect(feedItem.title).toBe("Untitled Hacker News story");
  });
});

describe("hackerNewsItemToFeedItem — url", () => {
  it("uses the story's external url when present", () => {
    const feedItem = hackerNewsItemToFeedItem(makeItem({ id: 1, url: "https://external.example/post" }));
    expect(feedItem.url).toBe("https://external.example/post");
  });

  it("falls back to the HN discussion page for a text-only ('Ask HN'-style) post with no url", () => {
    const feedItem = hackerNewsItemToFeedItem(makeItem({ id: 555, url: undefined }));
    expect(feedItem.url).toBe("https://news.ycombinator.com/item?id=555");
    expect(feedItem.url).toBe(feedItem.discussionUrl);
  });
});

describe("hackerNewsItemToFeedItem — publication timestamp", () => {
  it("converts a Unix-seconds 'time' into an ISO 8601 string", () => {
    const feedItem = hackerNewsItemToFeedItem(makeItem({ time: 1758500000 }));
    expect(feedItem.publishedAt).toBe(new Date(1758500000 * 1000).toISOString());
  });

  it("falls back to roughly now when 'time' is missing, rather than an invalid date", () => {
    const before = Date.now();
    const feedItem = hackerNewsItemToFeedItem(makeItem({ time: undefined }));
    const after = Date.now();
    const parsed = new Date(feedItem.publishedAt).getTime();
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});

describe("hackerNewsItemToFeedItem — score and comment metadata", () => {
  it("carries score and descendants through as score/commentCount", () => {
    const feedItem = hackerNewsItemToFeedItem(makeItem({ score: 314, descendants: 88 }));
    expect(feedItem.score).toBe(314);
    expect(feedItem.commentCount).toBe(88);
  });

  it("falls back to 0 (not undefined) when score/descendants are missing", () => {
    const feedItem = hackerNewsItemToFeedItem(makeItem({ score: undefined, descendants: undefined }));
    expect(feedItem.score).toBe(0);
    expect(feedItem.commentCount).toBe(0);
  });

  it("preserves a real, explicit 0 without conflating it with 'missing' (?? not ||)", () => {
    const feedItem = hackerNewsItemToFeedItem(makeItem({ score: 0, descendants: 0 }));
    expect(feedItem.score).toBe(0);
    expect(feedItem.commentCount).toBe(0);
  });
});

describe("hackerNewsItemToFeedItem — description", () => {
  it("falls back to a placeholder when 'text' is absent (the normal case for a link post)", () => {
    const feedItem = hackerNewsItemToFeedItem(makeItem({ text: undefined }));
    expect(feedItem.description).toBe("Discussion thread on Hacker News.");
  });

  it("converts a self-post's HTML 'text' into plain text", () => {
    const feedItem = hackerNewsItemToFeedItem(
      makeItem({ text: "A point about &amp; ampersands.<p>A second paragraph with a &#x2F; slash." })
    );
    expect(feedItem.description).not.toContain("<p>");
    expect(feedItem.description).toContain("A point about & ampersands.");
    expect(feedItem.description).toContain("A second paragraph with a / slash.");
  });
});
