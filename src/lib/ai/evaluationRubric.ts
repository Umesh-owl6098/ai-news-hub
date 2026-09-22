/**
 * Human-review rubric for AI-quality evaluation (Step 10 §8-9). This
 * module defines the rubric only — it never scores anything itself.
 * Automated structural checks (schema validity, latency, token usage)
 * are computed by the harness; summary factuality/usefulness and topic
 * correctness MUST be filled in by a human reading the actual output,
 * never by asking the same model to grade itself.
 */

export const SUMMARY_FACTUALITY_SCALE = {
  0: "materially invented/misleading",
  1: "partially accurate",
  2: "accurate",
} as const;

export const SUMMARY_USEFULNESS_SCALE = {
  0: "useless/redundant",
  1: "somewhat useful",
  2: "concise and informative",
} as const;

export const TOPIC_CORRECTNESS_SCALE = {
  0: "wrong",
  1: "partially right",
  2: "good",
} as const;

export type RubricScore = 0 | 1 | 2;

/**
 * Broad expected ranges for `relevanceScore`, not an exact target — the
 * score is model-generated subjective metadata (Step 9 §15). Adjust these
 * only with evidence from a real evaluation run, never speculatively.
 */
export const RELEVANCE_BANDS: Record<"high" | "medium" | "low", [number, number]> = {
  high: [0.7, 1.0],
  medium: [0.35, 0.69],
  low: [0.0, 0.34],
};

export function relevanceBandFor(score: number): "high" | "medium" | "low" {
  if (score >= RELEVANCE_BANDS.high[0]) return "high";
  if (score >= RELEVANCE_BANDS.medium[0]) return "medium";
  return "low";
}

/** One item's human review — every field starts unset; a person fills
 * these in after reading the actual generated summary/topics/score. */
export interface HumanReview {
  summaryFactuality: RubricScore | null;
  summaryUsefulness: RubricScore | null;
  topicCorrectness: RubricScore | null;
  /** Whether the relevance score's band feels defensible given the item —
   * a judgment call, not a formula. */
  relevanceScoreReasonable: boolean | null;
  notes: string;
}

export function emptyHumanReview(): HumanReview {
  return {
    summaryFactuality: null,
    summaryUsefulness: null,
    topicCorrectness: null,
    relevanceScoreReasonable: null,
    notes: "",
  };
}
