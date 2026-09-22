import { RssSourceConfig } from "@/types/rss";

// Verified with a real fetch before inclusion (2026-09-08):
// - OpenAI, Hugging Face, DeepMind, Google Research all returned 200 with
//   valid RSS 2.0 XML.
// - DeepMind: both `blog/rss.xml` and `blog/feed/basic/` responded, but
//   `feed/basic/` 302-redirects to `rss.xml` — using the direct URL.
// - Anthropic has no official RSS/Atom feed (every guessed URL 404s), so
//   it's intentionally omitted rather than scraped or guessed further.
//
// Step 25 additions (verified with a real fetch 2026-09-18) — chosen for
// DISTINCT coverage gaps the original 4 don't fill, not just "another
// company blog." See the Step 25 final report for the full candidate
// research (Anthropic/Meta AI/Mistral/NVIDIA/Microsoft/Apple/METR), but
// briefly:
// - Mistral AI: the only other major frontier model lab with an
//   *official* feed (`/rss.xml` redirects to the real endpoint below) —
//   0 mentions existed anywhere in the corpus before this, despite
//   "claude"/"anthropic" appearing organically 8x/4x via other sources'
//   text, suggesting real reader interest in frontier-lab coverage this
//   corpus wasn't serving for Mistral specifically.
// - NVIDIA Developer Blog: fills the corpus's weakest category
//   (hardware/inference/systems) — none of the original 4 publishers
//   cover GPU/data-center/inference-serving content at all. Atom format
//   (not RSS 2.0), parsed by the same generic adapter with zero code
//   changes.
// - Apple Machine Learning Research: real, substantial paper-abstract-
//   style content at a noticeably more active cadence than Microsoft
//   Research (a close second candidate, deferred — see final report) and
//   more consistently ML/AI-focused; zero title overlap found against
//   the persisted arXiv corpus in a real sample.
//
// None of the 3 provide native RSS categories (confirmed empty in real
// samples), so — matching the existing precedent for Hugging Face (which
// also has none) — no `defaultTags` is set; their items simply carry an
// empty `tags` array, exactly like Hugging Face's today.
export const RSS_SOURCES: RssSourceConfig[] = [
  {
    id: "openai",
    name: "OpenAI",
    feedUrl: "https://openai.com/news/rss.xml",
    siteUrl: "https://openai.com/news",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    feedUrl: "https://huggingface.co/blog/feed.xml",
    siteUrl: "https://huggingface.co/blog",
  },
  {
    id: "deepmind",
    name: "Google DeepMind",
    feedUrl: "https://deepmind.google/blog/rss.xml",
    siteUrl: "https://deepmind.google/blog/",
  },
  {
    id: "google-research",
    name: "Google Research",
    feedUrl: "https://research.google/blog/rss/",
    siteUrl: "https://research.google/blog/",
  },
  {
    id: "mistral",
    name: "Mistral AI",
    // The intuitive /rss.xml 301-redirects here — using the direct,
    // final URL to avoid an extra hop on every refresh (same reasoning
    // as DeepMind's direct-URL choice above).
    feedUrl: "https://mistral.ai/news/rss",
    siteUrl: "https://mistral.ai/news/",
  },
  {
    id: "nvidia-developer",
    name: "NVIDIA Developer",
    feedUrl: "https://developer.nvidia.com/blog/feed",
    siteUrl: "https://developer.nvidia.com/blog",
  },
  {
    id: "apple-ml-research",
    name: "Apple Machine Learning Research",
    feedUrl: "https://machinelearning.apple.com/rss.xml",
    siteUrl: "https://machinelearning.apple.com",
  },
];
