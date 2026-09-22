import { z } from "zod";
import { AI_TOPICS, MIN_TOPICS_PER_ITEM, MAX_TOPICS_PER_ITEM } from "@/lib/ai/taxonomy";

/**
 * Runtime schema for provider output. A model response is untrusted until
 * it passes this — "it parsed as JSON" is not the same as "it's safe to
 * persist and render." Anything that fails validation is classified as
 * `invalid_output` by the caller and never reaches the database.
 */
export const enrichmentOutputSchema = z.object({
  summary: z
    .string()
    .trim()
    .min(1, "summary must not be empty")
    .max(700, "summary must be a short 1-3 sentence blurb, not an essay"),
  topics: z
    .array(z.enum(AI_TOPICS))
    .min(MIN_TOPICS_PER_ITEM)
    .max(MAX_TOPICS_PER_ITEM)
    .refine((topics) => new Set(topics).size === topics.length, "topics must not repeat"),
  relevanceScore: z.number().min(0).max(1),
});

export type EnrichmentOutput = z.infer<typeof enrichmentOutputSchema>;
