import { FeedItem } from "@/types/feed";

const now = Date.now();
const hoursAgo = (hours: number) => new Date(now - hours * 60 * 60 * 1000).toISOString();

// Hacker News, arXiv, GitHub, and RSS news are all live now (see lib/sources/*.ts).
// Discussions has no live source yet, so it's the only remaining mock category.
export const mockFeedItems: FeedItem[] = [
  {
    id: "mock:discussion-deployment",
    sourceType: "discussion",
    sourceName: "Discussions",
    title: "What does responsible deployment actually look like for autonomous agents?",
    description:
      "A community thread collecting practical checklists and failure stories from teams shipping agentic systems in production.",
    publishedAt: hoursAgo(12),
    tags: ["AI Safety", "AI Agents"],
    score: 76,
    commentCount: 63,
    url: "https://example.com",
  },
];
