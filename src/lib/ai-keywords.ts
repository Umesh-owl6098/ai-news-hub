/**
 * Single source of truth for "is this AI-related" keyword matching.
 * Edit this list to tune what counts as an AI story.
 */
export const AI_KEYWORDS: string[] = [
  "AI",
  "artificial intelligence",
  "LLM",
  "LLMs",
  "large language model",
  "GPT",
  "Claude",
  "OpenAI",
  "Anthropic",
  "Gemini",
  "machine learning",
  "deep learning",
  "neural network",
  "transformer",
  "generative AI",
  "diffusion",
  "computer vision",
  "NLP",
  "agents",
  "agentic",
  "RAG",
  "embeddings",
  "vector database",
  "inference",
  "model training",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary matching so short terms like "AI" don't match inside
// unrelated words such as "email" or "maintain".
const AI_KEYWORD_PATTERN = new RegExp(
  `\\b(?:${AI_KEYWORDS.map(escapeRegExp).join("|")})\\b`,
  "i"
);

export function isAiRelatedTitle(title: string): boolean {
  if (!title) return false;
  return AI_KEYWORD_PATTERN.test(title);
}
