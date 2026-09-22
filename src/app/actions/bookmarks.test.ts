import { describe, expect, it, vi, beforeEach } from "vitest";

const addBookmark = vi.fn();
const removeBookmark = vi.fn();

vi.mock("@/db/repository", async () => {
  const actual = await vi.importActual<typeof import("@/db/repository")>("@/db/repository");
  return {
    ...actual,
    addBookmark: (...args: unknown[]) => addBookmark(...args),
    removeBookmark: (...args: unknown[]) => removeBookmark(...args),
  };
});

import { addBookmarkAction, removeBookmarkAction } from "./bookmarks";
import { DatabaseError } from "@/db/repository";

describe("addBookmarkAction / removeBookmarkAction", () => {
  beforeEach(() => {
    addBookmark.mockReset();
    removeBookmark.mockReset();
  });

  it("succeeds for a valid source key", async () => {
    addBookmark.mockResolvedValue(undefined);
    const result = await addBookmarkAction("hn:123456");
    expect(result).toEqual({ ok: true });
    expect(addBookmark).toHaveBeenCalledWith("hn:123456");
  });

  it("succeeds for a valid unbookmark", async () => {
    removeBookmark.mockResolvedValue(undefined);
    const result = await removeBookmarkAction("hn:123456");
    expect(result).toEqual({ ok: true });
    expect(removeBookmark).toHaveBeenCalledWith("hn:123456");
  });

  it("rejects a malformed request (non-string sourceKey) without touching the repository", async () => {
    const result = await addBookmarkAction({ malicious: "payload" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(addBookmark).not.toHaveBeenCalled();
  });

  it("rejects an empty source key", async () => {
    const result = await addBookmarkAction("");
    expect(result.ok).toBe(false);
    expect(addBookmark).not.toHaveBeenCalled();
  });

  it("rejects an oversized source key", async () => {
    const result = await addBookmarkAction("x".repeat(3000));
    expect(result.ok).toBe(false);
    expect(addBookmark).not.toHaveBeenCalled();
  });

  it("rejects a source key containing control characters", async () => {
    const result = await addBookmarkAction("hn:123\x00456");
    expect(result.ok).toBe(false);
    expect(addBookmark).not.toHaveBeenCalled();
  });

  it("returns the repository's safe error message for an unknown source key", async () => {
    addBookmark.mockRejectedValue(new DatabaseError("Couldn't save bookmark. Try again."));
    const result = await addBookmarkAction("hn:does-not-exist");
    expect(result).toEqual({ ok: false, error: "Couldn't save bookmark. Try again." });
  });

  it("classifies a DB-unavailable failure without leaking internal details", async () => {
    addBookmark.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432 password=hunter2"));
    const result = await addBookmarkAction("hn:123456");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Couldn't save bookmark. Try again.");
    expect(result.error).not.toMatch(/ECONNREFUSED|password|5432/);
  });

  it("classifies a DB-unavailable removal failure without leaking internal details", async () => {
    removeBookmark.mockRejectedValue(new Error("password authentication failed for user devuser"));
    const result = await removeBookmarkAction("hn:123456");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Couldn't remove bookmark. Try again.");
    expect(result.error).not.toMatch(/password|devuser/);
  });
});
