import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Static-analysis regression guards for Step 27 (Home feed information
 * architecture & source/publisher controls). Mirrors the pattern
 * established in refreshArchitecture.test.ts / readingStateArchitecture.test.ts.
 */
const projectRoot = path.resolve(__dirname, "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), "utf-8");
}

describe("Step 27 §2 — publisher options are canonically derived, never a second hardcoded list", () => {
  it("page.tsx builds PUBLISHER_OPTIONS from RSS_SOURCES, not an independent literal list", () => {
    const source = readSource("src/app/page.tsx");
    expect(source).toContain("RSS_SOURCES.map");
    expect(source).toMatch(/PUBLISHER_OPTIONS\s*=\s*RSS_SOURCES\.map/);
  });

  it("FeedFilters.tsx (where the publisher <select> now lives) contains no hardcoded publisher name list", () => {
    const source = readSource("src/components/FeedFilters.tsx");
    // A handful of real publisher names would indicate a second,
    // independently-maintained list — the component must only ever
    // receive them as a prop.
    expect(source).not.toMatch(/NVIDIA|Hugging Face|DeepMind|Mistral/);
  });
});

describe("Step 27 §5 — source type and publisher identity stay distinct controls", () => {
  it("the publisher <select> is gated on the News tab specifically in DashboardClient, not offered for every tab", () => {
    const source = readSource("src/components/DashboardClient.tsx");
    expect(source).toMatch(/publisherOptions=\{filter === "News" \? publisherOptions : \[\]\}/);
  });

  it("FeedFilters never repurposes the source-type tab selector to also carry publisher identity", () => {
    const source = readSource("src/components/FeedFilters.tsx");
    // The tab buttons (`filters` / `active` / `onChange`) and the publisher
    // <select> (`publisherOptions` / `selectedSource` / `onSourceChange`)
    // must remain two separate prop groups, never merged into one value.
    expect(source).toContain("publisherOptions");
    expect(source).toContain("selectedSource");
    expect(source).toContain("onSourceChange");
  });
});

describe("Step 27 §11 — publisher/source filtering happens in the DB query, never client-side", () => {
  it("DashboardClient never filters the item array by sourceId/publisher itself", () => {
    const source = readSource("src/components/DashboardClient.tsx");
    expect(source).not.toMatch(/\.filter\(\s*\(?item\)?\s*=>\s*item\.sourceId/);
    expect(source).not.toMatch(/\.filter\(\s*\(?item\)?\s*=>\s*item\.sourceName/);
  });

  it("performSearch forwards `source` straight through to the DB-level sourceId filter on both retrieval paths", () => {
    const source = readSource("src/lib/search.ts");
    expect(source).toContain("sourceId: state.source");
  });

  it("searchFeedItems applies sourceId as a real SQL WHERE condition, not a post-query filter", () => {
    const source = readSource("src/db/repository.ts");
    expect(source).toMatch(/eq\(feedItems\.sourceId, options\.sourceId\)/);
  });
});

describe("Step 27 — publisher filtering introduces no ingestion or AI/embedding calls", () => {
  const FILES = ["src/components/FeedFilters.tsx", "src/components/SearchControls.tsx", "src/lib/search.ts"];

  it.each(FILES)("%s imports no ingestion/source-adapter or AI module", (relativePath) => {
    const source = readSource(relativePath);
    expect(source).not.toMatch(/@\/lib\/sources\/(hackernews|arxiv|github|rss)/);
    expect(source).not.toMatch(/@\/lib\/ingest/);
    expect(source).not.toMatch(/from ["']@\/lib\/refreshService["']/);
  });
});

describe("Step 27 §13 — publisher/source filtering has no ranking effect", () => {
  it("briefing.ts, topics.ts never import the publisher/source filter state module", () => {
    for (const relativePath of ["src/lib/briefing.ts", "src/lib/topics.ts"]) {
      const source = readSource(relativePath);
      expect(source).not.toMatch(/@\/lib\/searchState/);
    }
  });
});

describe("Step 27 — the publisher filter never mutates bookmark/queue/read state", () => {
  it("FeedFilters.tsx imports no mutating Server Action — selecting a publisher only navigates", () => {
    const source = readSource("src/components/FeedFilters.tsx");
    expect(source).not.toMatch(/@\/app\/actions\//);
  });
});

describe("Step 27 — RightSidebar simplification removed only dead/mock UI", () => {
  it("RightSidebar.tsx no longer renders the non-functional mock panels", () => {
    const source = readSource("src/components/RightSidebar.tsx");
    expect(source).not.toMatch(/Personalized Feed/);
    expect(source).not.toMatch(/Top Stories Today/);
    expect(source).not.toMatch(/Your Digest/);
  });

  it("RightSidebar.tsx still renders the one real, persisted-state-backed panel", () => {
    const source = readSource("src/components/RightSidebar.tsx");
    expect(source).toContain("Recent Bookmarks");
    expect(source).toContain("recentBookmarks");
  });

  it("the removed mock data (personalizedTopics, topStoriesToday) is gone, not just unused", () => {
    const source = readSource("src/data/mockFeed.ts");
    expect(source).not.toMatch(/personalizedTopics/);
    expect(source).not.toMatch(/topStoriesToday/);
  });
});
