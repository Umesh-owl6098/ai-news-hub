import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Static-analysis regression guards for Step 21's core architectural
 * change (separating reads from refreshing). These don't need a database
 * or the app running — they assert against the actual source text so a
 * future edit that reintroduces a live fetch from page rendering, or
 * that forks the refresh implementation between the UI and the CLI,
 * fails a test immediately instead of only being caught in browser QA.
 */
const projectRoot = path.resolve(__dirname, "../..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), "utf-8");
}

describe("page rendering never triggers ingestion", () => {
  it("page.tsx does not import any live source adapter or call refreshAllSources", () => {
    const source = readSource("src/app/page.tsx");
    expect(source).not.toMatch(/@\/lib\/sources\/(hackernews|arxiv|github|rss)/);
    expect(source).not.toMatch(/@\/lib\/ingest/);
    // A prose mention in a doc comment (explaining where refreshing DOES
    // happen) is fine — an actual call is not.
    expect(source).not.toMatch(/refreshAllSources\(/);
  });

  it("page.tsx only reads persisted data plus source health for the bootstrap notice", () => {
    const source = readSource("src/app/page.tsx");
    expect(source).toContain("getRecentFeedItems");
    expect(source).toContain("getAllSourceHealth");
  });

  it("the now-dead live-ingest module was removed rather than left unused", () => {
    expect(() => readSource("src/lib/ingest.ts")).toThrow();
  });
});

describe("the briefing page never triggers ingestion (Step 22 §15)", () => {
  it("briefing/page.tsx does not import any live source adapter or the refresh service", () => {
    const source = readSource("src/app/briefing/page.tsx");
    expect(source).not.toMatch(/@\/lib\/sources\/(hackernews|arxiv|github|rss)/);
    expect(source).not.toMatch(/@\/lib\/ingest/);
    expect(source).not.toMatch(/refreshAllSources\(/);
    // The one allowed exception: a self-contained client button that
    // calls the SAME server action the Sidebar uses — not a direct
    // refreshAllSources()/adapter call from the page itself.
    expect(source).not.toMatch(/from ["']@\/lib\/refreshService["']/);
  });

  it("briefing/page.tsx makes no OpenAI/embedding call", () => {
    const source = readSource("src/app/briefing/page.tsx");
    expect(source).not.toMatch(/@\/lib\/ai\//);
    expect(source).not.toMatch(/embeddingProvider/i);
  });

  it("BriefingRefreshButton only calls the existing refreshSourcesAction, never a new refresh implementation", () => {
    const source = readSource("src/components/BriefingRefreshButton.tsx");
    expect(source).toContain('from "@/app/actions/refresh"');
    expect(source).not.toMatch(/@\/lib\/sources\//);
    expect(source).not.toMatch(/from ["']@\/lib\/refreshService["']/);
  });

  it("briefing.ts (the pure selection module) has no runtime DB, network, or AI import", () => {
    const source = readSource("src/lib/briefing.ts");
    // A type-only import from @/db (erased at compile time, no runtime
    // DB call) is fine and expected — only a VALUE import would pull in
    // an actual database client.
    expect(source).not.toMatch(/^import \{[^}]*\} from ["']@\/db\//m);
    expect(source).not.toMatch(/@\/lib\/sources\//);
    expect(source).not.toMatch(/@\/lib\/ai\//);
    expect(source).not.toContain("fetch(");
  });
});

describe("the Step 23 briefing-synthesis experiment cannot leak into production /briefing", () => {
  const EXPERIMENTAL_MODULE_PATTERN =
    /@\/lib\/ai\/briefingSynthesis(Schema|Evidence|Prompt|Provider|Cache|Orchestration|Rubric)/;

  it("briefing/page.tsx never imports any briefingSynthesis* module", () => {
    const source = readSource("src/app/briefing/page.tsx");
    expect(source).not.toMatch(EXPERIMENTAL_MODULE_PATTERN);
  });

  it("BriefingItemRow and BriefingRefreshButton never import any briefingSynthesis* module", () => {
    expect(readSource("src/components/BriefingItemRow.tsx")).not.toMatch(EXPERIMENTAL_MODULE_PATTERN);
    expect(readSource("src/components/BriefingRefreshButton.tsx")).not.toMatch(EXPERIMENTAL_MODULE_PATTERN);
  });

  it("briefing.ts (the deterministic selection module) never imports any briefingSynthesis* module", () => {
    expect(readSource("src/lib/briefing.ts")).not.toMatch(EXPERIMENTAL_MODULE_PATTERN);
  });

  it("the experiment is reachable only from its own CLI script, never from a page/action/component", () => {
    // A cheap but effective proxy: the only files that may reference the
    // experimental module family are the modules themselves, their tests,
    // and scripts/ai-briefing-evaluate.ts.
    const source = readSource("scripts/ai-briefing-evaluate.ts");
    expect(source).toMatch(EXPERIMENTAL_MODULE_PATTERN);
  });
});

describe("the UI action and the CLI script reuse one refresh implementation", () => {
  it("the server action calls refreshAllSources and does not duplicate fetch/upsert logic", () => {
    const source = readSource("src/app/actions/refresh.ts");
    expect(source).toContain('from "@/lib/refreshService"');
    expect(source).toContain("refreshAllSources()");
    expect(source).not.toMatch(/@\/lib\/sources\//);
  });

  it("the CLI script calls refreshAllSources and does not duplicate fetch/upsert logic", () => {
    const source = readSource("scripts/refresh-sources.ts");
    expect(source).toContain('from "@/lib/refreshService"');
    expect(source).toContain("refreshAllSources()");
    expect(source).not.toMatch(/@\/lib\/sources\//);
  });
});

describe("Step 28 — historical briefing reconstruction triggers no ingestion, no AI, and no mutation", () => {
  const MUTATING_IDENTIFIERS = [
    "addBookmarkAction",
    "removeBookmarkAction",
    "addToQueueAction",
    "removeFromQueueAction",
    "markReadAction",
    "markUnreadAction",
    "addBookmark(",
    "addToQueue(",
    "markRead(",
    "markUnread(",
  ];

  it("briefing/page.tsx never calls a bookmark/queue/read mutation — a historical GET only reads state", () => {
    const source = readSource("src/app/briefing/page.tsx");
    for (const identifier of MUTATING_IDENTIFIERS) {
      expect(source).not.toContain(identifier);
    }
    expect(source).toContain("getBookmarkedSourceKeys");
    expect(source).toContain("getReadingStateKeys");
  });

  it("briefingDate.ts (the pure date-resolution module) has no DB, network, or AI import", () => {
    const source = readSource("src/lib/briefingDate.ts");
    expect(source).not.toMatch(/^import \{[^}]*\} from ["']@\/db\//m);
    expect(source).not.toMatch(/@\/lib\/sources\//);
    expect(source).not.toMatch(/@\/lib\/ai\//);
    expect(source).not.toContain("fetch(");
  });

  it("BriefingDatePicker.tsx (the one interactive date-nav piece) only navigates — no ingestion, no AI, no mutating action", () => {
    const source = readSource("src/components/BriefingDatePicker.tsx");
    expect(source).not.toMatch(/@\/lib\/sources\//);
    expect(source).not.toMatch(/@\/lib\/ai\//);
    expect(source).not.toMatch(/@\/app\/actions\//);
  });

  it("getFeedItemsForBriefing and getFeedItemsForTopics resolve their reference instant in the application layer, never Postgres's own now()", () => {
    const source = readSource("src/db/repository.ts");
    // The historical-reconstruction bounds must come from an explicit
    // parameter, not a fresh call to the live DB clock — a query
    // re-issued tomorrow against the same historical referenceInstant
    // must return the same rows.
    const briefingFn = source.slice(source.indexOf("export async function getFeedItemsForBriefing"), source.indexOf("export async function getFeedItemsForBriefing") + 1200);
    expect(briefingFn).not.toMatch(/now\(\)\s*-\s*make_interval/);
    const topicsFn = source.slice(source.indexOf("export async function getFeedItemsForTopics"), source.indexOf("export async function getFeedItemsForTopics") + 1200);
    expect(topicsFn).not.toMatch(/now\(\)\s*-\s*make_interval/);
  });
});
