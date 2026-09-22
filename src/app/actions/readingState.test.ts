import { describe, expect, it, vi, beforeEach } from "vitest";

const addToQueue = vi.fn();
const removeFromQueue = vi.fn();
const markRead = vi.fn();
const markUnread = vi.fn();

vi.mock("@/db/repository", async () => {
  const actual = await vi.importActual<typeof import("@/db/repository")>("@/db/repository");
  return {
    ...actual,
    addToQueue: (...args: unknown[]) => addToQueue(...args),
    removeFromQueue: (...args: unknown[]) => removeFromQueue(...args),
    markRead: (...args: unknown[]) => markRead(...args),
    markUnread: (...args: unknown[]) => markUnread(...args),
  };
});

import { addToQueueAction, removeFromQueueAction, markReadAction, markUnreadAction } from "./readingState";
import { DatabaseError } from "@/db/repository";

describe("addToQueueAction / removeFromQueueAction", () => {
  beforeEach(() => {
    addToQueue.mockReset();
    removeFromQueue.mockReset();
  });

  it("succeeds for a valid source key", async () => {
    addToQueue.mockResolvedValue(undefined);
    const result = await addToQueueAction("hn:123456");
    expect(result).toEqual({ ok: true });
    expect(addToQueue).toHaveBeenCalledWith("hn:123456");
  });

  it("succeeds for a valid dequeue", async () => {
    removeFromQueue.mockResolvedValue(undefined);
    const result = await removeFromQueueAction("hn:123456");
    expect(result).toEqual({ ok: true });
    expect(removeFromQueue).toHaveBeenCalledWith("hn:123456");
  });

  it("rejects a malformed request (non-string sourceKey) without touching the repository", async () => {
    const result = await addToQueueAction({ malicious: "payload" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(addToQueue).not.toHaveBeenCalled();
  });

  it("rejects an empty source key", async () => {
    const result = await addToQueueAction("");
    expect(result.ok).toBe(false);
    expect(addToQueue).not.toHaveBeenCalled();
  });

  it("rejects a source key containing control characters", async () => {
    const result = await addToQueueAction("hn:123\x00456");
    expect(result.ok).toBe(false);
    expect(addToQueue).not.toHaveBeenCalled();
  });

  it("returns the repository's safe error message for an unknown source key", async () => {
    addToQueue.mockRejectedValue(new DatabaseError("Couldn't queue this item. Try again."));
    const result = await addToQueueAction("hn:does-not-exist");
    expect(result).toEqual({ ok: false, error: "Couldn't queue this item. Try again." });
  });

  it("classifies a DB-unavailable failure without leaking internal details", async () => {
    addToQueue.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432 password=hunter2"));
    const result = await addToQueueAction("hn:123456");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Couldn't queue this item. Try again.");
    expect(result.error).not.toMatch(/ECONNREFUSED|password|5432/);
  });

  it("classifies a DB-unavailable removal failure without leaking internal details", async () => {
    removeFromQueue.mockRejectedValue(new Error("password authentication failed for user devuser"));
    const result = await removeFromQueueAction("hn:123456");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Couldn't remove this item from the queue. Try again.");
    expect(result.error).not.toMatch(/password|devuser/);
  });
});

describe("markReadAction / markUnreadAction", () => {
  beforeEach(() => {
    markRead.mockReset();
    markUnread.mockReset();
  });

  it("succeeds for a valid source key", async () => {
    markRead.mockResolvedValue(undefined);
    const result = await markReadAction("hn:123456");
    expect(result).toEqual({ ok: true });
    expect(markRead).toHaveBeenCalledWith("hn:123456");
  });

  it("succeeds for a valid mark-unread", async () => {
    markUnread.mockResolvedValue(undefined);
    const result = await markUnreadAction("hn:123456");
    expect(result).toEqual({ ok: true });
    expect(markUnread).toHaveBeenCalledWith("hn:123456");
  });

  it("rejects a malformed request (non-string sourceKey) without touching the repository", async () => {
    const result = await markReadAction({ malicious: "payload" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(markRead).not.toHaveBeenCalled();
  });

  it("rejects an oversized source key", async () => {
    const result = await markReadAction("x".repeat(3000));
    expect(result.ok).toBe(false);
    expect(markRead).not.toHaveBeenCalled();
  });

  it("returns the repository's safe error message for an unknown source key", async () => {
    markRead.mockRejectedValue(new DatabaseError("Couldn't mark this item read. Try again."));
    const result = await markReadAction("hn:does-not-exist");
    expect(result).toEqual({ ok: false, error: "Couldn't mark this item read. Try again." });
  });

  it("classifies a DB-unavailable failure without leaking internal details", async () => {
    markUnread.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432 password=hunter2"));
    const result = await markUnreadAction("hn:123456");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Couldn't mark this item unread. Try again.");
    expect(result.error).not.toMatch(/ECONNREFUSED|password|5432/);
  });
});
