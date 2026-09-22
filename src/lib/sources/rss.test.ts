import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRssFeed, normalizeRssEntry, looksLikeCategoryEcho, getRssFeedItems } from "@/lib/sources/rss";
import { RSS_SOURCES } from "@/data/rssSources";
import type { RssSourceConfig, RssEntry } from "@/types/rss";
import { MAX_FEED_ITEM_TAGS } from "@/types/feed";

const source: RssSourceConfig = {
  id: "test-publisher",
  name: "Test Publisher",
  feedUrl: "https://example.com/feed.xml",
  siteUrl: "https://example.com",
};

function rssDocument(itemXml: string): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title>${itemXml}</channel></rss>`;
}

describe("looksLikeCategoryEcho", () => {
  it("detects an exact match between description and one of the item's own categories (the real Google Research pattern)", () => {
    expect(looksLikeCategoryEcho("Algorithms & Theory", ["Algorithms & Theory", "Generative AI"])).toBe(true);
  });

  it("does not flag a genuine summary that happens to mention a category word", () => {
    expect(looksLikeCategoryEcho("A new algorithm improves theory of mind benchmarks.", ["Algorithms & Theory"])).toBe(false);
  });

  it("does not flag an empty description", () => {
    expect(looksLikeCategoryEcho("", ["Algorithms & Theory"])).toBe(false);
  });

  it("does not flag when there are no categories at all", () => {
    expect(looksLikeCategoryEcho("Some summary", [])).toBe(false);
  });
});

describe("parseRssFeed — RSS 2.0 description handling (Step 24)", () => {
  it("falls back to 'No summary provided.' for a genuinely empty <description/> (e.g. real DeepMind items)", () => {
    const xml = rssDocument(
      "<item><title>A story</title><link>https://example.com/a</link><description/><pubDate>Tue, 15 Sep 2026 17:05:57 +0000</pubDate><guid>https://example.com/a</guid></item>"
    );
    const [entry] = parseRssFeed(xml, source);
    expect(entry.description).toBe("No summary provided.");
  });

  it("treats a description that exactly echoes the item's own category as 'no real summary' (the real Google Research pattern)", () => {
    const xml = rssDocument(
      "<item><title>A story</title><link>https://example.com/a</link><description>Generative AI</description>" +
        "<category>Generative AI</category><category>Machine Intelligence</category>" +
        "<pubDate>Tue, 15 Sep 2026 17:05:57 +0000</pubDate><guid>https://example.com/a</guid></item>"
    );
    const [entry] = parseRssFeed(xml, source);
    expect(entry.description).toBe("No summary provided.");
    // The categories themselves are still preserved as real tag data.
    expect(entry.categories).toEqual(["Generative AI", "Machine Intelligence"]);
  });

  it("keeps a genuine description that is unrelated to its categories", () => {
    const xml = rssDocument(
      "<item><title>A story</title><link>https://example.com/a</link><description>A real, independently-written summary.</description>" +
        "<category>Generative AI</category>" +
        "<pubDate>Tue, 15 Sep 2026 17:05:57 +0000</pubDate><guid>https://example.com/a</guid></item>"
    );
    const [entry] = parseRssFeed(xml, source);
    expect(entry.description).toBe("A real, independently-written summary.");
  });

  it("falls back to content:encoded when description is empty", () => {
    const xml = rssDocument(
      "<item><title>A story</title><link>https://example.com/a</link><description/>" +
        "<content:encoded><![CDATA[<p>Full body text here.</p>]]></content:encoded>" +
        "<pubDate>Tue, 15 Sep 2026 17:05:57 +0000</pubDate><guid>https://example.com/a</guid></item>"
    );
    const [entry] = parseRssFeed(xml, source);
    expect(entry.description).toBe("Full body text here.");
  });

  it("strips HTML tags and decodes entities in the description", () => {
    const xml = rssDocument(
      "<item><title>A story</title><link>https://example.com/a</link>" +
        "<description><![CDATA[<p>Tom &amp; Jerry</p>]]></description>" +
        "<pubDate>Tue, 15 Sep 2026 17:05:57 +0000</pubDate><guid>https://example.com/a</guid></item>"
    );
    const [entry] = parseRssFeed(xml, source);
    expect(entry.description).toBe("Tom & Jerry");
  });

  it("drops an item with no title or no link rather than fabricating one", () => {
    const xml = rssDocument(
      "<item><description>orphaned</description><pubDate>Tue, 15 Sep 2026 17:05:57 +0000</pubDate></item>"
    );
    expect(parseRssFeed(xml, source)).toEqual([]);
  });

  it("throws on genuinely malformed/non-feed XML", () => {
    expect(() => parseRssFeed("<html><body>not a feed</body></html>", source)).toThrow();
  });
});

describe("normalizeRssEntry — tags cap (Step 24)", () => {
  function entryWithCategories(categories: string[]): RssEntry {
    return {
      id: "guid:1",
      title: "Title",
      link: "https://example.com/a",
      description: "desc",
      publishedAt: "2026-09-18T00:00:00.000Z",
      authors: [],
      categories,
      sourceId: source.id,
      sourceName: source.name,
    };
  }

  it("keeps up to MAX_FEED_ITEM_TAGS categories rather than truncating to 3", () => {
    const categories = Array.from({ length: 5 }, (_, i) => `cat-${i}`);
    const item = normalizeRssEntry(entryWithCategories(categories), source);
    expect(item.tags).toEqual(categories);
    expect(item.tags.length).toBeGreaterThan(3);
  });

  it("still bounds an extreme/pathological category list at MAX_FEED_ITEM_TAGS", () => {
    const categories = Array.from({ length: MAX_FEED_ITEM_TAGS + 10 }, (_, i) => `cat-${i}`);
    const item = normalizeRssEntry(entryWithCategories(categories), source);
    expect(item.tags).toHaveLength(MAX_FEED_ITEM_TAGS);
  });

  it("falls back to the source's default tags when the entry has no categories", () => {
    const sourceWithDefaults: RssSourceConfig = { ...source, defaultTags: ["Fallback"] };
    const item = normalizeRssEntry(entryWithCategories([]), sourceWithDefaults);
    expect(item.tags).toEqual(["Fallback"]);
  });
});

// --- Step 25: source-specific fixtures for the 3 newly integrated feeds ---
//
// Each fixture is a small, hand-trimmed snippet modeled on the REAL feed
// structure observed during candidate research (2026-09-18) — never a
// live re-fetch. All three route through the exact same generic
// parseRssFeed/normalizeRssEntry used by the original 4 sources; these
// tests exist to prove each source's actual real-world shape (not a
// hypothetical one) survives that shared pipeline correctly.

describe("Mistral AI — real feed shape (RSS 2.0, guid=permalink, frequently-missing description)", () => {
  const mistralSource: RssSourceConfig = {
    id: "mistral",
    name: "Mistral AI",
    feedUrl: "https://mistral.ai/news/rss",
    siteUrl: "https://mistral.ai/news/",
  };

  it("parses a real-shaped item with a description", () => {
    const xml = rssDocument(
      "<item><title>Mistral raises €3B to make sovereign, open-weight AI the technology frontier</title>" +
        "<link>https://mistral.ai/news/mistral-makes-sovereign-open-weight-ai-to-frontier/</link>" +
        '<guid isPermaLink="true">https://mistral.ai/news/mistral-makes-sovereign-open-weight-ai-to-frontier/</guid>' +
        "<description>Mistral today announced that it has raised €3 billion in a Series D funding round.</description>" +
        "<pubDate>Tue, 08 Sep 2026 12:00:22 GMT</pubDate></item>"
    );
    const [entry] = parseRssFeed(xml, mistralSource);
    expect(entry.title).toBe("Mistral raises €3B to make sovereign, open-weight AI the technology frontier");
    expect(entry.description).toBe("Mistral today announced that it has raised €3 billion in a Series D funding round.");
    expect(entry.id).toBe("https://mistral.ai/news/mistral-makes-sovereign-open-weight-ai-to-frontier/");
  });

  it("falls back to 'No summary provided.' for a real Mistral item with no <description> at all (observed in ~20% of a recent sample)", () => {
    const xml = rssDocument(
      "<item><title>Mistral x HUMAIN</title>" +
        "<link>https://mistral.ai/news/mistral-x-humain/</link>" +
        '<guid isPermaLink="true">https://mistral.ai/news/mistral-x-humain/</guid>' +
        "<pubDate>Mon, 24 Aug 2026 16:02:41 GMT</pubDate></item>"
    );
    const [entry] = parseRssFeed(xml, mistralSource);
    expect(entry.description).toBe("No summary provided.");
  });

  it("has no native categories (confirmed 0 in the real feed) — normalizes to an empty tags array, same as Hugging Face today", () => {
    const item = normalizeRssEntry(
      {
        id: "https://mistral.ai/news/example/",
        title: "Example",
        link: "https://mistral.ai/news/example/",
        description: "desc",
        publishedAt: "2026-09-08T12:00:22.000Z",
        authors: [],
        categories: [],
        sourceId: mistralSource.id,
        sourceName: mistralSource.name,
      },
      mistralSource
    );
    expect(item.tags).toEqual([]);
  });
});

describe("NVIDIA Developer Blog — real feed shape (Atom, multi-category, image-prefixed summary)", () => {
  const nvidiaSource: RssSourceConfig = {
    id: "nvidia-developer",
    name: "NVIDIA Developer",
    feedUrl: "https://developer.nvidia.com/blog/feed",
    siteUrl: "https://developer.nvidia.com/blog",
  };

  function atomDocument(entryXml: string): string {
    return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>NVIDIA Technical Blog</title>${entryXml}</feed>`;
  }

  it("parses a real-shaped Atom entry: multiple categories, and a summary whose leading <img> is stripped leaving real text", () => {
    const xml = atomDocument(
      "<entry>" +
        "<author><name>Tanya Lenz</name></author>" +
        '<title type="html"><![CDATA[How to Use AI Agents to Prepare 3D Scenes for Simulation]]></title>' +
        '<link rel="alternate" type="text/html" href="https://developer.nvidia.com/blog/how-to-use-ai-agents-to-prepare-3d-scenes-for-simulation/" />' +
        "<id>https://developer.nvidia.com/blog/?p=122626</id>" +
        "<published>2026-09-16T23:20:33Z</published>" +
        '<category scheme="https://developer.nvidia.com/blog" term="Agentic AI / Generative AI" />' +
        '<category scheme="https://developer.nvidia.com/blog" term="Simulation / Modeling / Design" />' +
        '<category scheme="https://developer.nvidia.com/blog" term="Physical AI" />' +
        '<summary type="html"><![CDATA[<img width="768" height="432" src="https://developer-blogs.nvidia.com/wp-content/uploads/example.png" /> Agentic AI workflows can be used to prepare and validate digital twins for physical AI systems.]]></summary>' +
        "</entry>"
    );
    const [entry] = parseRssFeed(xml, nvidiaSource);
    expect(entry.title).toBe("How to Use AI Agents to Prepare 3D Scenes for Simulation");
    expect(entry.description).toBe("Agentic AI workflows can be used to prepare and validate digital twins for physical AI systems.");
    expect(entry.description).not.toContain("<img");
    expect(entry.categories).toEqual(["Agentic AI / Generative AI", "Simulation / Modeling / Design", "Physical AI"]);
    expect(entry.authors).toEqual(["Tanya Lenz"]);
  });

  it("keeps every category (real entries commonly have 4-5) rather than truncating to 3", () => {
    const item = normalizeRssEntry(
      {
        id: "https://developer.nvidia.com/blog/?p=1",
        title: "Example",
        link: "https://developer.nvidia.com/blog/example/",
        description: "desc",
        publishedAt: "2026-09-16T23:20:33.000Z",
        authors: [],
        categories: ["Agentic AI / Generative AI", "AI Inference", "Data Center / Cloud", "LLMs", "NVLink"],
        sourceId: nvidiaSource.id,
        sourceName: nvidiaSource.name,
      },
      nvidiaSource
    );
    expect(item.tags).toHaveLength(5);
  });
});

describe("Apple Machine Learning Research — real feed shape (RSS 2.0, slug-only non-URL guid)", () => {
  const appleSource: RssSourceConfig = {
    id: "apple-ml-research",
    name: "Apple Machine Learning Research",
    feedUrl: "https://machinelearning.apple.com/rss.xml",
    siteUrl: "https://machinelearning.apple.com",
  };

  it("parses a real-shaped item whose <guid> is a bare slug, not a URL", () => {
    const xml = rssDocument(
      "<item><guid>reversal-bench-rl-cliff</guid>" +
        "<title>REVERSAL-BENCH: A Reversibility Axis and Reset Oracle for Measuring the Reset-Free RL Cliff</title>" +
        "<link>https://machinelearning.apple.com/research/reversal-bench-rl-cliff</link>" +
        "<description>A central goal of autonomous reinforcement learning is continuous policy training without external resets.</description>" +
        "<pubDate>Thu, 17 Sep 2026 00:00:00 GMT</pubDate></item>"
    );
    const [entry] = parseRssFeed(xml, appleSource);
    // The bare slug guid is used as-is (it's still a stable, unique
    // string) — never replaced by the canonical link, which would be
    // wrong here (the guid IS the feed's own stable identity).
    expect(entry.id).toBe("reversal-bench-rl-cliff");
    expect(entry.link).toBe("https://machinelearning.apple.com/research/reversal-bench-rl-cliff");
    expect(entry.description).toContain("autonomous reinforcement learning");
  });

  it("has no native categories (confirmed 0 in the real feed) — normalizes to an empty tags array", () => {
    const item = normalizeRssEntry(
      {
        id: "example-slug",
        title: "Example",
        link: "https://machinelearning.apple.com/research/example",
        description: "desc",
        publishedAt: "2026-09-17T00:00:00.000Z",
        authors: [],
        categories: [],
        sourceId: appleSource.id,
        sourceName: appleSource.name,
      },
      appleSource
    );
    expect(item.tags).toEqual([]);
  });
});

describe("Step 25 — malformed entry isolation across the new sources' real shapes", () => {
  it("drops a malformed entry (no title) while keeping well-formed real-shaped entries from the same feed", () => {
    const xml = rssDocument(
      "<item><description>orphaned, no title or link</description><pubDate>Tue, 15 Sep 2026 00:00:00 GMT</pubDate></item>" +
        "<item><title>A real Mistral-shaped item</title><link>https://mistral.ai/news/real/</link>" +
        '<guid isPermaLink="true">https://mistral.ai/news/real/</guid>' +
        "<description>Real content.</description><pubDate>Tue, 15 Sep 2026 12:00:00 GMT</pubDate></item>"
    );
    const entries = parseRssFeed(xml, source);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("A real Mistral-shaped item");
  });
});

describe("getRssFeedItems — cross-publisher cap scales with the configured publisher count (Step 25)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not let one high-cadence publisher starve the others out of the combined result", async () => {
    // Every one of the app's REAL configured publishers returns a full
    // MAX_ENTRIES_PER_SOURCE-worth of well-formed, staggered-recency
    // items. Before Step 25's fix, a flat MAX_TOTAL_ITEMS=40 (hand-picked
    // for 4 publishers) would have silently dropped every item from
    // whichever publishers' items happened to sort past position 40 —
    // exactly what a real refresh measured happening to Mistral/DeepMind
    // once NVIDIA's near-daily cadence was added. With the cap now scaled
    // to RSS_SOURCES.length * 10, all of them fit.
    const now = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        const matched = RSS_SOURCES.find((s) => url === s.feedUrl);
        if (!matched) throw new Error(`unexpected fetch URL in test: ${url}`);
        const items = Array.from({ length: 10 }, (_, i) => {
          const published = new Date(now - i * 60_000).toUTCString();
          return (
            `<item><title>${matched.id} item ${i}</title>` +
            `<link>https://example.com/${matched.id}/${i}</link>` +
            `<guid>https://example.com/${matched.id}/${i}</guid>` +
            `<description>desc</description><pubDate>${published}</pubDate></item>`
          );
        }).join("");
        const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>${matched.name}</title>${items}</channel></rss>`;
        return new Response(xml, { status: 200, headers: { "content-type": "application/rss+xml" } });
      })
    );

    const result = await getRssFeedItems();

    expect(result.items).toHaveLength(RSS_SOURCES.length * 10);
    for (const publisher of RSS_SOURCES) {
      const count = result.items.filter((item) => item.sourceId === publisher.id).length;
      expect(count).toBe(10);
    }
  });
});
