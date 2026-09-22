/**
 * Fixed, bounded topic taxonomy for AI enrichment. Deliberately small and
 * closed — the model must pick from this list, never invent new labels —
 * so topic chips stay consistent across thousands of items instead of
 * accumulating hundreds of one-off strings. Derived from the shapes of the
 * four real sources already in the app (Hacker News, arXiv, GitHub,
 * AI-publisher RSS): research papers land in "AI Research"/specific
 * subfields, repos in "Open Source"/"Developer Tools", vendor announcements
 * in "Products"/"Business", etc.
 */
export const AI_TOPICS = [
  "LLMs",
  "Agents",
  "Machine Learning",
  "Computer Vision",
  "NLP",
  "Robotics",
  "AI Safety",
  "AI Research",
  "Developer Tools",
  "Open Source",
  "Infrastructure",
  "Hardware",
  "Products",
  "Business",
  "Policy",
  "Other",
] as const;

export type AiTopic = (typeof AI_TOPICS)[number];

export const MIN_TOPICS_PER_ITEM = 1;
export const MAX_TOPICS_PER_ITEM = 4;
