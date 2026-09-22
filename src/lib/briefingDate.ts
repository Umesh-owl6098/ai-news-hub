/**
 * Step 28 — URL <-> reference-instant parsing for `/briefing?date=`,
 * mirroring `searchState.ts`'s role for search: the one place a
 * `?date=` query parameter (untrusted user input) is validated and
 * turned into the deterministic instant the rest of the briefing pipeline
 * actually needs. Pure, dependency-free, no DB/network/AI.
 *
 * Application timezone: this app has no existing timezone convention (no
 * prior code converts a timestamp to a specific zone for display — see
 * `lib/time.ts`'s purely relative "3h ago" formatting) and every persisted
 * timestamp is `timestamptz` (UTC internally) already. Rather than
 * introducing a timezone-conversion dependency for a single-user personal
 * app with no user-configurable timezone, this makes UTC the one
 * explicit, documented application timezone: a calendar date "2026-09-20"
 * means 2026-09-20 in UTC, and "end of that day" means 23:59:59.999 UTC.
 */
export const APPLICATION_TIMEZONE = "UTC";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" for `date` as a calendar date in the application timezone (UTC). */
export function formatBriefingDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Parses a "YYYY-MM-DD" string into the deterministic reference instant
 * for that calendar day: 23:59:59.999 UTC. Returns `null` for anything
 * that isn't syntactically a date, or that doesn't round-trip (e.g.
 * "2026-02-30", which `Date.UTC` would otherwise silently roll into
 * March) — this is what makes leap days work correctly (2024-02-29 round-
 * trips; 2026-02-29 does not, since 2026 isn't a leap year) without a
 * calendar library.
 */
export function parseBriefingDateEndOfDayUtc(raw: string): Date | null {
  const match = DATE_PATTERN.exec(raw);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));

  const roundTrips =
    instant.getUTCFullYear() === year && instant.getUTCMonth() === month - 1 && instant.getUTCDate() === day;
  return roundTrips ? instant : null;
}

export interface BriefingDateResolution {
  /** The calendar date actually being rendered, "YYYY-MM-DD" in UTC —
   * always a valid date, never after today. */
  effectiveDate: string;
  /** True for the live, current-instant briefing (no `?date=`, or a
   * request that resolved to today) — `referenceInstant` is the actual
   * current instant then, not an end-of-day boundary, so "today" never
   * pretends the day has already ended. */
  isToday: boolean;
  /** The deterministic upper-bound instant every selection function below
   * this is anchored to (both the eligibility window's upper bound and
   * the anchor for its rolling 72h lower bound). */
  referenceInstant: Date;
  /** Set only when the requested `?date=` was malformed or in the future —
   * the page must surface this rather than silently substituting today. */
  notice: string | null;
  /** True when `?date=` exactly names today — the page should redirect to
   * the canonical, dateless `/briefing` rather than render this shape
   * (not an error, so no `notice`). */
  shouldCanonicalizeToToday: boolean;
}

/**
 * Resolves `/briefing`'s `?date=` parameter against `now` (the real
 * current instant — injectable for deterministic tests). See
 * `BriefingDateResolution` field docs for the exact contract of each
 * outcome (today / historical / invalid / future / same-as-today).
 */
export function resolveBriefingDate(rawDateParam: string | undefined, now: Date = new Date()): BriefingDateResolution {
  const todayStr = formatBriefingDate(now);

  if (!rawDateParam) {
    return { effectiveDate: todayStr, isToday: true, referenceInstant: now, notice: null, shouldCanonicalizeToToday: false };
  }

  if (rawDateParam === todayStr) {
    return { effectiveDate: todayStr, isToday: true, referenceInstant: now, notice: null, shouldCanonicalizeToToday: true };
  }

  const endOfDay = parseBriefingDateEndOfDayUtc(rawDateParam);
  if (!endOfDay) {
    return {
      effectiveDate: todayStr,
      isToday: true,
      referenceInstant: now,
      notice: `"${rawDateParam}" isn't a valid date — showing today's briefing instead.`,
      shouldCanonicalizeToToday: false,
    };
  }

  if (endOfDay.getTime() > now.getTime()) {
    return {
      effectiveDate: todayStr,
      isToday: true,
      referenceInstant: now,
      notice: `${rawDateParam} hasn't happened yet — showing today's briefing instead.`,
      shouldCanonicalizeToToday: false,
    };
  }

  return { effectiveDate: rawDateParam, isToday: false, referenceInstant: endOfDay, notice: null, shouldCanonicalizeToToday: false };
}

/** One calendar day earlier/later than `date` ("YYYY-MM-DD", UTC). */
export function shiftBriefingDate(date: string, deltaDays: number): string {
  const endOfDay = parseBriefingDateEndOfDayUtc(date);
  if (!endOfDay) return date;
  const shifted = new Date(endOfDay.getTime() + deltaDays * 24 * 60 * 60 * 1000);
  return formatBriefingDate(shifted);
}
