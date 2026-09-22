/**
 * All FeedItem.publishedAt values are ISO 8601 timestamps (the
 * source-of-truth for sorting). This derives a human-readable relative
 * label for display only — never store the label itself.
 *
 * `referenceInstant` defaults to the real current time (every existing
 * caller is unaffected) — Step 28 passes an explicit past instant from
 * `/briefing?date=` so a historical briefing's rows read "2d ago" relative
 * to the date being viewed, not relative to today, which would otherwise
 * contradict the page's own "Briefing for Sep 18" heading.
 */
export function formatRelativeTime(iso: string, referenceInstant: Date = new Date()): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "";

  const diffMs = referenceInstant.getTime() - time;
  const diffMinutes = Math.max(1, Math.round(diffMs / 60_000));

  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;

  const diffMonths = Math.round(diffDays / 30);
  return `${diffMonths}mo ago`;
}
