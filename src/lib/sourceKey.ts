// Shared by every Server Action that takes a `FeedItem.id`-shaped
// `sourceKey` (bookmarks, reading queue, read state) — Server Actions are
// public endpoints, same as a route handler, so input is validated here,
// not just trusted from the client, even though this is a single-user app
// with no auth to check (per Vercel's "authenticate server actions like
// API routes" guidance: validate inside the action).

// Generous but bounded — real source keys look like "hn:123456" or
// "rss:openai:<canonical-url>", so this must comfortably fit a URL while
// still rejecting garbage/abuse-sized input. No control characters.
const MAX_SOURCE_KEY_LENGTH = 2048;
const CONTROL_CHARS_PATTERN = /[\x00-\x1f\x7f]/;

export function validateSourceKey(sourceKey: unknown): string | null {
  if (typeof sourceKey !== "string") return null;
  if (sourceKey.length === 0 || sourceKey.length > MAX_SOURCE_KEY_LENGTH) return null;
  if (CONTROL_CHARS_PATTERN.test(sourceKey)) return null;
  return sourceKey;
}
