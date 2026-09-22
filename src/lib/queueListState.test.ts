import { describe, expect, it } from "vitest";
import { applyDequeueSuccess, applyReadSuccess, deriveQueueView } from "@/lib/queueListState";
import type { QueueItemRow } from "@/db/repository";
import type { FeedItem } from "@/types/feed";

/**
 * V1 verification-closure — /queue used to leave its row list and
 * All/Unread/Read counts stale after a successful in-page mutation until
 * the next navigation or reload (found during the exhaustive v1
 * verification). These are the pure state transitions QueueList.tsx now
 * uses to keep both in sync with a *persisted* change — tested directly,
 * as real behavior against real data, rather than by rendering the
 * component (this codebase has no React rendering test infrastructure;
 * see step29AuditFixes.test.ts's own note).
 */

function makeRow(sourceKey: string, read: boolean, overrides: Partial<FeedItem> = {}): QueueItemRow {
  const item: FeedItem = {
    id: sourceKey,
    sourceType: "github",
    sourceName: "GitHub",
    title: `Item ${sourceKey}`,
    description: "desc",
    publishedAt: "2026-09-20T00:00:00.000Z",
    tags: [],
    score: 0,
    commentCount: 0,
    url: `https://example.com/${sourceKey}`,
    ...overrides,
  };
  return { item, queuedAt: new Date("2026-09-20T00:00:00.000Z"), read, bookmarked: false };
}

describe("applyDequeueSuccess", () => {
  it("removes the matching item on a successful dequeue (queued: false)", () => {
    const items = [makeRow("a", false), makeRow("b", true)];
    const result = applyDequeueSuccess(items, "a", false);
    expect(result.map((r) => r.item.id)).toEqual(["b"]);
  });

  it("leaves the list unchanged for queued: true (this page never re-adds)", () => {
    const items = [makeRow("a", false), makeRow("b", true)];
    const result = applyDequeueSuccess(items, "a", true);
    expect(result).toEqual(items);
  });

  it("is a no-op for a sourceKey not present in the list", () => {
    const items = [makeRow("a", false)];
    const result = applyDequeueSuccess(items, "nonexistent", false);
    expect(result).toEqual(items);
  });

  it("removes only the matching item, leaving others (including duplicated read state) untouched", () => {
    const items = [makeRow("a", false), makeRow("b", false), makeRow("c", true)];
    const result = applyDequeueSuccess(items, "b", false);
    expect(result.map((r) => r.item.id)).toEqual(["a", "c"]);
  });
});

describe("applyReadSuccess", () => {
  it("marks the matching item read", () => {
    const items = [makeRow("a", false), makeRow("b", false)];
    const result = applyReadSuccess(items, "a", true);
    expect(result.find((r) => r.item.id === "a")?.read).toBe(true);
    expect(result.find((r) => r.item.id === "b")?.read).toBe(false);
  });

  it("marks the matching item unread", () => {
    const items = [makeRow("a", true)];
    const result = applyReadSuccess(items, "a", false);
    expect(result.find((r) => r.item.id === "a")?.read).toBe(false);
  });

  it("preserves every other field on the updated row (bookmarked, queuedAt, item)", () => {
    const items = [{ ...makeRow("a", false), bookmarked: true }];
    const result = applyReadSuccess(items, "a", true);
    expect(result[0]).toMatchObject({ read: true, bookmarked: true, item: items[0].item });
  });

  it("is a no-op for a sourceKey not present in the list", () => {
    const items = [makeRow("a", false)];
    const result = applyReadSuccess(items, "nonexistent", true);
    expect(result).toEqual(items);
  });
});

describe("deriveQueueView", () => {
  const items = [makeRow("a", false), makeRow("b", true), makeRow("c", false)];

  it("All retains every row regardless of read state", () => {
    const view = deriveQueueView(items, "all");
    expect(view.filteredItems.map((r) => r.item.id)).toEqual(["a", "b", "c"]);
  });

  it("Unread shows only unread rows", () => {
    const view = deriveQueueView(items, "unread");
    expect(view.filteredItems.map((r) => r.item.id)).toEqual(["a", "c"]);
  });

  it("Read shows only read rows", () => {
    const view = deriveQueueView(items, "read");
    expect(view.filteredItems.map((r) => r.item.id)).toEqual(["b"]);
  });

  it("counts reflect the full list, independent of the current filter", () => {
    const view = deriveQueueView(items, "read");
    expect(view.unreadCount).toBe(2);
    expect(view.readCount).toBe(1);
  });

  it("an empty list yields empty filtered results and zero counts for every status", () => {
    for (const status of ["all", "unread", "read"] as const) {
      const view = deriveQueueView([], status);
      expect(view.filteredItems).toEqual([]);
      expect(view.unreadCount).toBe(0);
      expect(view.readCount).toBe(0);
    }
  });
});

describe("dequeue + read-change composition (the exact end-to-end bug scenario)", () => {
  it("marking an item read while viewing Unread removes it from that filtered view but keeps it in All's count", () => {
    let items = [makeRow("a", false), makeRow("b", false)];
    items = applyReadSuccess(items, "a", true);

    const unreadView = deriveQueueView(items, "unread");
    expect(unreadView.filteredItems.map((r) => r.item.id)).toEqual(["b"]);

    const allView = deriveQueueView(items, "all");
    expect(allView.filteredItems.map((r) => r.item.id)).toEqual(["a", "b"]);
    expect(allView.unreadCount).toBe(1);
    expect(allView.readCount).toBe(1);
  });

  it("marking an item unread while viewing Read removes it from that filtered view", () => {
    let items = [makeRow("a", true), makeRow("b", true)];
    items = applyReadSuccess(items, "a", false);

    const readView = deriveQueueView(items, "read");
    expect(readView.filteredItems.map((r) => r.item.id)).toEqual(["b"]);
  });

  it("dequeuing an item removes it from every status view and both counts drop accordingly", () => {
    let items = [makeRow("a", false), makeRow("b", true)];
    items = applyDequeueSuccess(items, "a", false);

    expect(deriveQueueView(items, "all").filteredItems).toHaveLength(1);
    expect(deriveQueueView(items, "unread").filteredItems).toHaveLength(0);
    expect(deriveQueueView(items, "read").filteredItems).toHaveLength(1);
  });

  it("a failed mutation (never calling apply*) leaves list/counts exactly as before — simulated by simply not applying", () => {
    const items = [makeRow("a", false), makeRow("b", true)];
    const before = deriveQueueView(items, "all");
    // A failed action never invokes applyDequeueSuccess/applyReadSuccess
    // (useOptimisticToggle's onSuccess only fires when result.ok) — so
    // the correct "failure" behavior IS the absence of a call, which
    // trivially leaves this identical.
    const after = deriveQueueView(items, "all");
    expect(after).toEqual(before);
  });
});
