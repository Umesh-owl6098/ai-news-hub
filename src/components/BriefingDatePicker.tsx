"use client";

import { useRouter } from "next/navigation";

interface BriefingDatePickerProps {
  /** "YYYY-MM-DD" — the date currently being viewed. */
  value: string;
  /** "YYYY-MM-DD" — today, in the application timezone (UTC). Passed down
   * from the server rather than computed client-side so this never risks
   * a hydration mismatch against the server's own notion of "today". */
  max: string;
}

/**
 * The one genuinely interactive piece of `/briefing`'s date navigation —
 * Previous/Next/Today are plain server-rendered `<Link>`s (see
 * briefing/page.tsx), matching this app's established convention for
 * simple state changes (Topics' window selector, Queue's status filter).
 * A native `<input type="date">` needs an onChange handler to navigate,
 * so it's the only part that needs to be a client component.
 *
 * `max` is a UX hint only, not the enforcement boundary — picking a
 * future date still round-trips through the server's own
 * `resolveBriefingDate`, which safely falls back to today with a visible
 * notice (see briefingDate.ts), the same as typing one directly into the URL.
 */
export function BriefingDatePicker({ value, max }: BriefingDatePickerProps) {
  const router = useRouter();

  return (
    <label className="flex items-center gap-1.5 text-sm text-slate-600">
      <span className="sr-only">Briefing date</span>
      <input
        type="date"
        value={value}
        max={max}
        onChange={(e) => {
          const next = e.target.value;
          if (!next) return;
          router.push(next === max ? "/briefing" : `/briefing?date=${next}`);
        }}
        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
      />
    </label>
  );
}
