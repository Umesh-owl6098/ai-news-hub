import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Static-analysis regression guards for the v1 verification-closure Queue
 * fix, mirroring the pattern established in step29AuditFixes.test.ts /
 * refreshArchitecture.test.ts — this codebase has no React rendering test
 * infrastructure, so the actual list/count behavior is covered by real
 * behavioral tests against pure logic (queueListState.test.ts); these
 * guard the wiring that connects a successful mutation to that logic, and
 * were additionally verified live via browser reproduction — see the
 * closure report.
 */
const projectRoot = path.resolve(__dirname, "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), "utf-8");
}

describe("useOptimisticToggle onSuccess fires only on a persisted (not optimistic) success", () => {
  it("calls onSuccess inside the ok branch, never unconditionally", () => {
    const source = readSource("src/lib/useOptimisticToggle.ts");
    // The success branch: onSuccess?.(next) must appear as the `else` of
    // the `if (!result.ok)` check — i.e. never called before knowing the
    // action actually persisted, and never called on the failure path
    // (which instead rolls `value` back and sets `error`).
    expect(source).toMatch(/if \(!result\.ok\)[\s\S]*?\}\s*else\s*\{\s*onSuccess\?\.\(next\);\s*\}/);
  });

  it("still rolls back value and sets error on failure, unchanged from the Step 29 pattern", () => {
    const source = readSource("src/lib/useOptimisticToggle.ts");
    expect(source).toContain("setValue(!next)");
    expect(source).toContain("setError(result.error ?? fallbackError)");
  });
});

describe("QueueButton / ReadToggleButton thread an optional onSuccess through to useOptimisticToggle", () => {
  it("QueueButton accepts and forwards onSuccess", () => {
    const source = readSource("src/components/QueueButton.tsx");
    expect(source).toMatch(/onSuccess\?:\s*\(queued: boolean\) => void/);
    expect(source).toMatch(/useOptimisticToggle\(\s*initialQueued,[\s\S]*?onSuccess\s*\)/);
  });

  it("ReadToggleButton accepts and forwards onSuccess", () => {
    const source = readSource("src/components/ReadToggleButton.tsx");
    expect(source).toMatch(/onSuccess\?:\s*\(read: boolean\) => void/);
    expect(source).toMatch(/useOptimisticToggle\(\s*initialRead,[\s\S]*?onSuccess\s*\)/);
  });

  it("BookmarkButton is untouched by this fix — no onSuccess plumbing added", () => {
    const source = readSource("src/components/BookmarkButton.tsx");
    expect(source).not.toContain("onSuccess");
  });
});

describe("QueueRow forwards the persisted-success callbacks to its buttons", () => {
  it("wires onQueueSuccess/onReadSuccess into QueueButton/ReadToggleButton", () => {
    const source = readSource("src/components/QueueRow.tsx");
    expect(source).toContain("onQueueSuccess");
    expect(source).toContain("onReadSuccess");
    expect(source).toMatch(/<ReadToggleButton[\s\S]*?onSuccess=\{onReadSuccess\}/);
    expect(source).toMatch(/<QueueButton[\s\S]*?onSuccess=\{onQueueSuccess\}/);
  });
});

describe("QueueList resyncs from fresh server data without clobbering local mutations", () => {
  it("adjusts local items during render (not useEffect) when the initialItems prop identity changes", () => {
    const source = readSource("src/components/QueueList.tsx");
    // Mirrors SearchBar.tsx's render-time resync pattern, not an effect
    // (an effect here trips react-hooks/set-state-in-effect and causes
    // an avoidable extra render — see useOptimisticToggle's own doc
    // comment for the same reasoning applied to a single boolean).
    expect(source).toMatch(/if \(initialItems !== prevInitialItems\) \{\s*setPrevInitialItems\(initialItems\);\s*setItems\(initialItems\);\s*\}/);
    // Checks actual hook usage, not prose — this doc comment itself
    // explains why an effect was deliberately avoided, which would trip
    // a blanket substring search.
    expect(source).not.toMatch(/useEffect\(/);
  });

  it("derives counts and the filtered list from local state, not the original server list", () => {
    const source = readSource("src/components/QueueList.tsx");
    expect(source).toMatch(/deriveQueueView\(items, status\)/);
    expect(source).not.toMatch(/deriveQueueView\(initialItems/);
  });
});

describe("QueuePage delegates list/count rendering to QueueList", () => {
  it("no longer computes filteredItems/unreadCount/readCount itself", () => {
    const source = readSource("src/app/queue/page.tsx");
    expect(source).not.toContain("filteredItems");
    expect(source).not.toContain("unreadCount");
    expect(source).not.toContain("readCount");
    expect(source).toContain("<QueueList");
  });

  it("still fetches the full, unfiltered queue in one query (no added per-row lookups)", () => {
    const source = readSource("src/app/queue/page.tsx");
    expect(source).toContain("getQueueItems()");
  });
});
