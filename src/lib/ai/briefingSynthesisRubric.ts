/**
 * Step 23 §9 — human-evaluation rubric for the AI briefing synthesis
 * experiment. Mirrors `evaluationRubric.ts`'s role for article enrichment:
 * this module defines the rubric only, it never scores anything itself.
 * A human must read the actual deterministic-vs-AI comparison and fill
 * these in — never the model grading its own output.
 */

export const GROUNDED_FACTUALITY_SCALE = {
  2: "every substantive statement is supported by supplied evidence",
  1: "mostly supported but contains an inference or overstatement",
  0: "clear unsupported factual claim",
} as const;

export const ADDED_USEFULNESS_SCALE = {
  2: "materially helps understand the selected stories faster, or reveals a well-supported connection",
  1: "mostly paraphrases/repackages what the deterministic briefing already shows",
  0: "misleading, distracting, or less useful",
} as const;

export const CONCISION_SCALE = {
  2: "compact and information-dense",
  1: "somewhat verbose/repetitive",
  0: "substantially bloated",
} as const;

export const CONNECTION_QUALITY_SCALE = {
  2: "specific cross-item relationships are supported and genuinely useful",
  1: "relationships are obvious/generic",
  0: "unsupported or misleading connections",
} as const;

export type RubricScore = 0 | 1 | 2;

export const PREFERENCE_OPTIONS = ["deterministic only", "deterministic + AI synthesis", "no preference"] as const;
export type PreferenceOption = (typeof PREFERENCE_OPTIONS)[number];

/** One evaluation run's human review — every field starts unset. */
export interface BriefingSynthesisHumanReview {
  groundedFactuality: RubricScore | null;
  addedUsefulness: RubricScore | null;
  concision: RubricScore | null;
  connectionQuality: RubricScore | null;
  preference: PreferenceOption | null;
  notes: string;
}

export function emptyBriefingSynthesisHumanReview(): BriefingSynthesisHumanReview {
  return {
    groundedFactuality: null,
    addedUsefulness: null,
    concision: null,
    connectionQuality: null,
    preference: null,
    notes: "",
  };
}
