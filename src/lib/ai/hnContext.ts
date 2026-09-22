import "server-only";
import { getHackerNewsItem } from "@/lib/sources/hackernews";
import { htmlToPlainText } from "@/lib/html";

/**
 * Step 13 input-quality experiment: fetches a small, bounded slice of a
 * Hacker News story's own discussion (via the same official Firebase API
 * the production ingestion adapter already uses — never HTML scraping)
 * to test whether real discussion context improves enrichment usefulness
 * for stories whose own text is a placeholder ("Discussion thread on
 * Hacker News."). Not wired into production ingestion or persistence —
 * this is evaluation-only, called from scripts/ai-augment-hn.ts.
 */
const MAX_TOP_LEVEL_COMMENTS = 5;
const MAX_TOTAL_CHARS = 3500;
const LABEL = "Hacker News discussion context";

export interface HnContextResult {
  label: string;
  text: string;
  /** How many comment fetches were actually made — for reporting request counts. */
  commentRequestCount: number;
}

/**
 * At most 1 (story) + MAX_TOP_LEVEL_COMMENTS (comments) Firebase requests
 * per story — never a recursive descent into reply threads, never more
 * than a handful of requests per article.
 *
 * Return/throw contract (Step 16): callers need to distinguish "Hacker
 * News definitively has nothing usable" from "we couldn't even reach
 * Hacker News" — the former is safe to persist as a confirmed result,
 * the latter must never be. `getHackerNewsItem` itself never throws (by
 * design — see hackernews.ts, "a single bad item shouldn't take down the
 * whole feed"), so a null story here is the one place that ambiguity
 * would otherwise leak through undetected; this function turns it into
 * an explicit throw instead. A `null` *return value* is reserved
 * exclusively for "the story resolved fine, but has no usable text or
 * comments" — a real, confirmed answer, never an outage in disguise.
 */
export async function fetchHnDiscussionContext(storyId: number): Promise<HnContextResult | null> {
  const story = await getHackerNewsItem(storyId);
  if (!story) {
    throw new Error(`Hacker News story ${storyId} could not be fetched (network issue or the story is gone).`);
  }

  const parts: string[] = [];
  if (story.text) {
    const storyText = htmlToPlainText(story.text);
    if (storyText) parts.push(`Story text: ${storyText}`);
  }

  const topLevelKids = (story.kids ?? []).slice(0, MAX_TOP_LEVEL_COMMENTS);
  const comments = await Promise.all(topLevelKids.map((id) => getHackerNewsItem(id)));

  // Preserve HN's own ordering (the `kids` array order) — never
  // re-sorted, so the same story always yields the same context.
  let commentRequestCount = 0;
  for (const comment of comments) {
    commentRequestCount++;
    if (!comment) continue;
    if (comment.deleted || comment.dead) continue;
    if (!comment.text) continue;
    const plain = htmlToPlainText(comment.text);
    if (!plain) continue;
    const author = comment.by ?? "anonymous";
    parts.push(`Comment (${author}): ${plain}`);
  }

  if (parts.length === 0) return null;

  // Bound the TOTAL context, not each part independently — join first,
  // then truncate once, so the budget is spent on whichever comments
  // came first in HN's own order rather than being divided evenly
  // regardless of length.
  let text = parts.join("\n\n");
  if (text.length > MAX_TOTAL_CHARS) {
    text = `${text.slice(0, MAX_TOTAL_CHARS)}…`;
  }

  return { label: LABEL, text, commentRequestCount };
}
