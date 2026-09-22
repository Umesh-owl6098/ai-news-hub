import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./time";

describe("formatRelativeTime", () => {
  it("defaults to the real current time when no referenceInstant is given (existing behavior unchanged)", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(fiveMinutesAgo)).toBe("5m ago");
  });

  it("returns an empty string for an unparseable timestamp", () => {
    expect(formatRelativeTime("not-a-timestamp")).toBe("");
  });

  it("Step 28: computes relative to an explicit referenceInstant, not the real current time", () => {
    const referenceInstant = new Date("2026-09-18T23:59:59.999Z");
    const twoDaysBefore = new Date("2026-09-16T23:59:59.999Z").toISOString();
    expect(formatRelativeTime(twoDaysBefore, referenceInstant)).toBe("2d ago");
  });

  it("the same publishedAt reads differently against a historical referenceInstant than against today", () => {
    const publishedAt = "2026-09-16T12:00:00.000Z";
    const historicalReference = new Date("2026-09-18T12:00:00.000Z"); // 2 days later
    const laterReference = new Date("2026-09-25T12:00:00.000Z"); // 9 days later

    expect(formatRelativeTime(publishedAt, historicalReference)).toBe("2d ago");
    expect(formatRelativeTime(publishedAt, laterReference)).toBe("9d ago");
  });
});
