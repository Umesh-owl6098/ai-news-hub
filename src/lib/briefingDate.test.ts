import { describe, expect, it } from "vitest";
import {
  APPLICATION_TIMEZONE,
  formatBriefingDate,
  parseBriefingDateEndOfDayUtc,
  resolveBriefingDate,
  shiftBriefingDate,
} from "./briefingDate";

describe("APPLICATION_TIMEZONE", () => {
  it("is the documented, explicit constant (UTC)", () => {
    expect(APPLICATION_TIMEZONE).toBe("UTC");
  });
});

describe("parseBriefingDateEndOfDayUtc", () => {
  it("parses a valid date to 23:59:59.999 UTC on that day", () => {
    const result = parseBriefingDateEndOfDayUtc("2026-09-20");
    expect(result?.toISOString()).toBe("2026-09-20T23:59:59.999Z");
  });

  it("rejects malformed input (wrong shape, non-numeric, extra text)", () => {
    expect(parseBriefingDateEndOfDayUtc("not-a-date")).toBeNull();
    expect(parseBriefingDateEndOfDayUtc("2026-9-20")).toBeNull(); // must be zero-padded
    expect(parseBriefingDateEndOfDayUtc("2026/09/20")).toBeNull();
    expect(parseBriefingDateEndOfDayUtc("2026-09-20T00:00:00Z")).toBeNull();
    expect(parseBriefingDateEndOfDayUtc("")).toBeNull();
    expect(parseBriefingDateEndOfDayUtc("2026-09-20; DROP TABLE feed_items;")).toBeNull();
  });

  it("rejects a date that doesn't round-trip (e.g. day 30 of a 29-day month)", () => {
    expect(parseBriefingDateEndOfDayUtc("2026-02-30")).toBeNull();
    expect(parseBriefingDateEndOfDayUtc("2026-04-31")).toBeNull();
    expect(parseBriefingDateEndOfDayUtc("2026-13-01")).toBeNull(); // month 13
  });

  it("leap day: accepts Feb 29 on a leap year, rejects it on a non-leap year", () => {
    expect(parseBriefingDateEndOfDayUtc("2024-02-29")?.toISOString()).toBe("2024-02-29T23:59:59.999Z"); // 2024 is a leap year
    expect(parseBriefingDateEndOfDayUtc("2026-02-29")).toBeNull(); // 2026 is not
  });
});

describe("formatBriefingDate / shiftBriefingDate round-trip", () => {
  it("formats a Date back to the same YYYY-MM-DD string", () => {
    expect(formatBriefingDate(new Date("2026-09-20T23:59:59.999Z"))).toBe("2026-09-20");
  });

  it("shifts by whole days, including across a month boundary", () => {
    expect(shiftBriefingDate("2026-09-20", -1)).toBe("2026-09-19");
    expect(shiftBriefingDate("2026-09-20", 1)).toBe("2026-09-21");
    expect(shiftBriefingDate("2026-10-01", -1)).toBe("2026-09-30");
    expect(shiftBriefingDate("2026-02-28", 1)).toBe("2026-03-01"); // 2026 is not a leap year
    expect(shiftBriefingDate("2024-02-28", 1)).toBe("2024-02-29"); // 2024 is
  });
});

describe("resolveBriefingDate", () => {
  const now = new Date("2026-09-20T14:30:00.000Z"); // "today" = 2026-09-20, mid-day

  it("no ?date= param: today, using the actual current instant (never a pretend end-of-day)", () => {
    const result = resolveBriefingDate(undefined, now);
    expect(result).toEqual({
      effectiveDate: "2026-09-20",
      isToday: true,
      referenceInstant: now,
      notice: null,
      shouldCanonicalizeToToday: false,
    });
  });

  it("?date=<today's date> canonicalizes to today rather than rendering a redundant end-of-day view", () => {
    const result = resolveBriefingDate("2026-09-20", now);
    expect(result.shouldCanonicalizeToToday).toBe(true);
    expect(result.isToday).toBe(true);
    expect(result.notice).toBeNull();
    // Even though canonicalizing, the resolution itself still uses the
    // real current instant, not an end-of-day boundary for today.
    expect(result.referenceInstant).toBe(now);
  });

  it("a valid past date resolves to that day's end-of-day UTC reference instant", () => {
    const result = resolveBriefingDate("2026-09-18", now);
    expect(result).toEqual({
      effectiveDate: "2026-09-18",
      isToday: false,
      referenceInstant: new Date("2026-09-18T23:59:59.999Z"),
      notice: null,
      shouldCanonicalizeToToday: false,
    });
  });

  it("yesterday resolves correctly", () => {
    const result = resolveBriefingDate("2026-09-19", now);
    expect(result.effectiveDate).toBe("2026-09-19");
    expect(result.isToday).toBe(false);
    expect(result.referenceInstant.toISOString()).toBe("2026-09-19T23:59:59.999Z");
  });

  it("a malformed date falls back to today with a clear, non-hidden notice", () => {
    const result = resolveBriefingDate("not-a-date", now);
    expect(result.isToday).toBe(true);
    expect(result.effectiveDate).toBe("2026-09-20");
    expect(result.referenceInstant).toBe(now);
    expect(result.notice).toContain("isn't a valid date");
    expect(result.notice).toContain("not-a-date");
    expect(result.shouldCanonicalizeToToday).toBe(false);
  });

  it("a future date falls back to today with a clear, non-hidden notice — never rendered as a 'future briefing'", () => {
    const result = resolveBriefingDate("2026-09-21", now); // tomorrow relative to `now`
    expect(result.isToday).toBe(true);
    expect(result.effectiveDate).toBe("2026-09-20");
    expect(result.referenceInstant).toBe(now);
    expect(result.notice).toContain("hasn't happened yet");
    expect(result.shouldCanonicalizeToToday).toBe(false);
  });

  it("a far-future date is rejected the same way as tomorrow", () => {
    const result = resolveBriefingDate("2030-01-01", now);
    expect(result.isToday).toBe(true);
    expect(result.notice).toContain("hasn't happened yet");
  });

  it("exact boundary: the instant one millisecond before today's end-of-day is still 'today', not treated as a distinct future point", () => {
    // This exercises the boundary indirectly: 2026-09-20 IS today, so it
    // canonicalizes regardless of what time within the day `now` is.
    const earlyMorning = new Date("2026-09-20T00:00:00.001Z");
    const result = resolveBriefingDate("2026-09-20", earlyMorning);
    expect(result.shouldCanonicalizeToToday).toBe(true);
  });

  it("a date exactly one year in the past has no arbitrary horizon cutoff (Step 28 §6 — no 30-day limit)", () => {
    const result = resolveBriefingDate("2025-09-20", now);
    expect(result.isToday).toBe(false);
    expect(result.notice).toBeNull();
    expect(result.effectiveDate).toBe("2025-09-20");
  });
});
