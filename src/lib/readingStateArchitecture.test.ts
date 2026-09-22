import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Static-analysis regression guards for Step 26 (reading queue & read
 * state). These don't need a database or the app running — they assert
 * against the actual source text so a future edit that reintroduces an
 * automatic read mutation on GET, or that lets queue/read state leak into
 * ranking/personalization, fails a test immediately instead of only being
 * caught in browser QA. Mirrors the pattern established in
 * refreshArchitecture.test.ts for Step 21+.
 */
const projectRoot = path.resolve(__dirname, "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), "utf-8");
}

const MUTATING_READING_STATE_IDENTIFIERS = [
  "addToQueue",
  "removeFromQueue",
  "markRead(",
  "markUnread(",
  "addToQueueAction",
  "removeFromQueueAction",
  "markReadAction",
  "markUnreadAction",
];

describe("Step 26 §8 — opening an item never mutates read state", () => {
  it("item/[id]/page.tsx never calls a reading-state mutation — only reads getReadingStateKeys", () => {
    const source = readSource("src/app/item/[id]/page.tsx");
    expect(source).toContain("getReadingStateKeys");
    for (const identifier of MUTATING_READING_STATE_IDENTIFIERS) {
      expect(source).not.toContain(identifier);
    }
  });

  it("ReadToggleButton is the only place markReadAction/markUnreadAction are invoked from the client", () => {
    const source = readSource("src/components/ReadToggleButton.tsx");
    expect(source).toContain("markReadAction");
    expect(source).toContain("markUnreadAction");
  });
});

describe("Step 26 — viewing /queue never mutates queue, read, or bookmark state", () => {
  it("queue/page.tsx never calls a reading-state (or bookmark) mutation — only reads getQueueItems", () => {
    const source = readSource("src/app/queue/page.tsx");
    expect(source).toContain("getQueueItems");
    for (const identifier of MUTATING_READING_STATE_IDENTIFIERS) {
      expect(source).not.toContain(identifier);
    }
    expect(source).not.toMatch(/\baddBookmark\b/);
    expect(source).not.toMatch(/\bremoveBookmark\b/);
  });
});

describe("Step 26 §10 — reading queue/read state never triggers ingestion", () => {
  const READING_STATE_FILES = [
    "src/app/actions/readingState.ts",
    "src/app/queue/page.tsx",
    "src/components/QueueButton.tsx",
    "src/components/ReadToggleButton.tsx",
    "src/components/QueueRow.tsx",
  ];

  it.each(READING_STATE_FILES)("%s imports no ingestion/source-adapter module", (relativePath) => {
    const source = readSource(relativePath);
    expect(source).not.toMatch(/@\/lib\/sources\/(hackernews|arxiv|github|rss)/);
    expect(source).not.toMatch(/@\/lib\/ingest/);
    expect(source).not.toMatch(/from ["']@\/lib\/refreshService["']/);
    expect(source).not.toMatch(/refreshAllSources\(/);
  });

  it("the reading-state repository section imports no ingestion/AI module", () => {
    const source = readSource("src/db/repository.ts");
    // The file as a whole legitimately has no ingestion import at all —
    // asserting on the whole file is a stronger guarantee than isolating
    // just the reading-state section, and just as accurate here.
    expect(source).not.toMatch(/@\/lib\/sources\//);
    expect(source).not.toMatch(/@\/lib\/ingest/);
    expect(source).not.toMatch(/@\/lib\/ai\//);
  });
});

describe("Step 26 §9 — reading queue/read state has no ranking or personalization effect", () => {
  const RANKING_FILES = ["src/lib/briefing.ts", "src/lib/topics.ts", "src/lib/search.ts"];

  it.each(RANKING_FILES)("%s never imports reading-state functions or the readingState table", (relativePath) => {
    const source = readSource(relativePath);
    expect(source).not.toMatch(/readingState/);
    expect(source).not.toMatch(/getReadingStateKeys/);
    expect(source).not.toMatch(/getQueueItems/);
    expect(source).not.toMatch(/getUnreadQueuedCount/);
  });

  it("page.tsx (Home) reads reading state only for display — never passes it into ranking/dedup/sort helpers", () => {
    const source = readSource("src/app/page.tsx");
    expect(source).toContain("getReadingStateKeys");
    expect(source).toContain("getUnreadQueuedCount");
    // Every mutation is client-only, reachable solely via a Server Action —
    // the Home Server Component itself must never call one directly.
    for (const identifier of MUTATING_READING_STATE_IDENTIFIERS) {
      expect(source).not.toContain(identifier);
    }
  });

  it("briefing/page.tsx reads queued state only for display — never mutates it", () => {
    const source = readSource("src/app/briefing/page.tsx");
    expect(source).toContain("getReadingStateKeys");
    for (const identifier of MUTATING_READING_STATE_IDENTIFIERS) {
      expect(source).not.toContain(identifier);
    }
  });
});
