import { describe, expect, it } from "vitest";
import {
  buildBriefingEvidence,
  computeEvidenceHash,
  validateBriefingSynthesisGrounding,
  type BriefingEvidenceItem,
} from "@/lib/ai/briefingSynthesisEvidence";
import type { BriefingSections } from "@/lib/briefing";
import type { FeedItem, SourceType } from "@/types/feed";
import type { BriefingSynthesisOutput } from "@/lib/ai/briefingSynthesisSchema";

let counter = 0;
function makeItem(sourceType: SourceType, overrides: Partial<FeedItem> = {}): FeedItem {
  counter += 1;
  const id = overrides.id ?? `${sourceType}:${counter}`;
  return {
    id,
    sourceType,
    sourceName: sourceType,
    title: `Title ${id}`,
    description: `Description for ${id}`,
    publishedAt: "2026-09-17T00:00:00.000Z",
    tags: [],
    score: 0,
    commentCount: 0,
    url: `https://example.com/${id}`,
    ...overrides,
  };
}

function emptySections(): BriefingSections {
  return { topStories: [], research: [], projects: [], newsAndDiscussion: [] };
}

describe("buildBriefingEvidence", () => {
  it("returns one evidence item per FeedItem, tagged with its section", () => {
    const hn = makeItem("hackernews", { score: 42, commentCount: 7 });
    const gh = makeItem("github", { stars: 100, forks: 20, language: "Rust" });
    const sections: BriefingSections = { ...emptySections(), topStories: [hn], projects: [gh] };

    const evidence = buildBriefingEvidence(sections);
    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({ itemId: hn.id, section: "topStories", hn: { score: 42, commentCount: 7 }, github: null });
    expect(evidence[1]).toMatchObject({ itemId: gh.id, section: "projects", github: { stars: 100, forks: 20, language: "Rust" }, hn: null });
  });

  it("excludes URLs, embeddings, and bookmark state entirely — only the documented fields exist", () => {
    const item = makeItem("news");
    const evidence = buildBriefingEvidence({ ...emptySections(), newsAndDiscussion: [item] });
    const keys = Object.keys(evidence[0]);
    expect(keys).toEqual(["itemId", "section", "title", "sourceType", "publisher", "publishedAt", "summary", "authors", "tags", "hn", "github"]);
    expect(JSON.stringify(evidence)).not.toContain("example.com");
  });

  it("clamps an overlong summary rather than sending it unbounded", () => {
    const longDescription = "x".repeat(5000);
    const item = makeItem("paper", { description: longDescription });
    const evidence = buildBriefingEvidence({ ...emptySections(), research: [item] });
    expect(evidence[0].summary!.length).toBeLessThan(longDescription.length);
  });

  it("represents an empty description as null, not an empty string", () => {
    const item = makeItem("news", { description: "" });
    const evidence = buildBriefingEvidence({ ...emptySections(), newsAndDiscussion: [item] });
    expect(evidence[0].summary).toBeNull();
  });
});

describe("computeEvidenceHash", () => {
  it("is stable across repeated calls given identical input", () => {
    const evidence = buildBriefingEvidence({ ...emptySections(), topStories: [makeItem("github")] });
    const h1 = computeEvidenceHash(evidence, "gpt-5.6-luna", "v1");
    const h2 = computeEvidenceHash(evidence, "gpt-5.6-luna", "v1");
    expect(h1).toBe(h2);
  });

  it("changes when the evidence content changes", () => {
    const a = buildBriefingEvidence({ ...emptySections(), topStories: [makeItem("github", { title: "A" })] });
    const b = buildBriefingEvidence({ ...emptySections(), topStories: [makeItem("github", { title: "B" })] });
    expect(computeEvidenceHash(a, "gpt-5.6-luna", "v1")).not.toBe(computeEvidenceHash(b, "gpt-5.6-luna", "v1"));
  });

  it("changes when the model changes, evidence held constant", () => {
    const evidence = buildBriefingEvidence({ ...emptySections(), topStories: [makeItem("github")] });
    expect(computeEvidenceHash(evidence, "gpt-5.6-luna", "v1")).not.toBe(computeEvidenceHash(evidence, "gpt-5.6-terra", "v1"));
  });

  it("changes when the prompt version changes, evidence and model held constant", () => {
    const evidence = buildBriefingEvidence({ ...emptySections(), topStories: [makeItem("github")] });
    expect(computeEvidenceHash(evidence, "gpt-5.6-luna", "v1")).not.toBe(computeEvidenceHash(evidence, "gpt-5.6-luna", "v2"));
  });
});

describe("validateBriefingSynthesisGrounding", () => {
  function evidenceFor(items: FeedItem[]): BriefingEvidenceItem[] {
    return buildBriefingEvidence({ ...emptySections(), topStories: items });
  }

  function hl(itemId: string, summary: string) {
    return { itemId, summary, whyItMatters: null };
  }

  function output(overrides: Partial<BriefingSynthesisOutput> & { highlights: BriefingSynthesisOutput["highlights"] }): BriefingSynthesisOutput {
    return { headline: "h", overview: "o", connections: null, ...overrides };
  }

  it("finds no issues for a fully-grounded output", () => {
    const items = [makeItem("github", { title: "Repo A" }), makeItem("paper", { title: "Paper B" })];
    const evidence = evidenceFor(items);
    const out = output({
      highlights: [hl(evidence[0].itemId, "Summary of repo A."), hl(evidence[1].itemId, "Summary of paper B.")],
      connections: [{ itemIds: [evidence[0].itemId, evidence[1].itemId], observation: "Both cite the same technique." }],
    });
    expect(validateBriefingSynthesisGrounding(out, evidence)).toEqual([]);
  });

  it("flags a highlight referencing an itemId not in evidence", () => {
    const evidence = evidenceFor([makeItem("github")]);
    const out = output({ highlights: [hl("not-a-real-id", "s")] });
    const issues = validateBriefingSynthesisGrounding(out, evidence);
    expect(issues.some((i) => i.severity === "error" && i.message.includes("unknown itemId"))).toBe(true);
  });

  it("flags a duplicate highlight itemId", () => {
    const evidence = evidenceFor([makeItem("github")]);
    const out = output({ highlights: [hl(evidence[0].itemId, "s1"), hl(evidence[0].itemId, "s2")] });
    const issues = validateBriefingSynthesisGrounding(out, evidence);
    expect(issues.some((i) => i.message.includes("duplicate highlight"))).toBe(true);
  });

  it("flags a connection with fewer than 2 distinct itemIds even if the array has 2+ entries", () => {
    const evidence = evidenceFor([makeItem("github")]);
    const out = output({
      highlights: [hl(evidence[0].itemId, "s")],
      connections: [{ itemIds: [evidence[0].itemId, evidence[0].itemId], observation: "obs" }],
    });
    const issues = validateBriefingSynthesisGrounding(out, evidence);
    expect(issues.some((i) => i.message.includes("at least 2 distinct"))).toBe(true);
  });

  it("flags a connection referencing an unknown itemId", () => {
    const evidence = evidenceFor([makeItem("github"), makeItem("paper")]);
    const out = output({
      highlights: [hl(evidence[0].itemId, "s")],
      connections: [{ itemIds: [evidence[0].itemId, "unknown:id"], observation: "obs" }],
    });
    const issues = validateBriefingSynthesisGrounding(out, evidence);
    expect(issues.some((i) => i.message.includes("unknown itemId"))).toBe(true);
  });

  it("flags a precise number in generated text absent from the evidence", () => {
    const evidence = evidenceFor([makeItem("hackernews", { title: "Show HN", score: 42, commentCount: 3 })]);
    const out = output({
      overview: "This item reached 999 points overnight.", // 999 never appears in evidence
      highlights: [hl(evidence[0].itemId, "s")],
    });
    const issues = validateBriefingSynthesisGrounding(out, evidence);
    expect(issues.some((i) => i.severity === "warning" && i.message.includes("999"))).toBe(true);
  });

  it("does not flag a number that legitimately appears in the evidence (e.g. the real HN score)", () => {
    const evidence = evidenceFor([makeItem("hackernews", { title: "Show HN", score: 142, commentCount: 30 })]);
    const out = output({ highlights: [hl(evidence[0].itemId, "This reached 142 points with 30 comments.")] });
    const issues = validateBriefingSynthesisGrounding(out, evidence);
    expect(issues.filter((i) => i.severity === "warning")).toEqual([]);
  });

  describe("Step 24 — comma thousands-separator normalization", () => {
    it("does not flag a comma-grouped number that exactly matches an evidence value (the real Call 3 false positive)", () => {
      const evidence = evidenceFor([makeItem("github", { title: "llama.cpp", stars: 128379, forks: 23243 })]);
      const out = output({
        highlights: [hl(evidence[0].itemId, "llama.cpp has 128,379 stars and 23,243 forks.")],
      });
      const issues = validateBriefingSynthesisGrounding(out, evidence);
      expect(issues.filter((i) => i.severity === "warning")).toEqual([]);
    });

    it("does not flag a comma-grouped decimal that matches evidence", () => {
      const evidence = evidenceFor([makeItem("news", { title: "Funding round", description: "Raised 1234.5 million." })]);
      const out = output({ highlights: [hl(evidence[0].itemId, "The company raised 1,234.5 million.")] });
      const issues = validateBriefingSynthesisGrounding(out, evidence);
      expect(issues.filter((i) => i.severity === "warning")).toEqual([]);
    });

    it("still extracts a legitimate percentage figure and matches it against evidence", () => {
      const evidence = evidenceFor([makeItem("paper", { title: "Benchmark", description: "Reduced the error rate by 32.1%." })]);
      const out = output({ highlights: [hl(evidence[0].itemId, "The paper reports a 32.1% reduction.")] });
      const issues = validateBriefingSynthesisGrounding(out, evidence);
      expect(issues.filter((i) => i.severity === "warning")).toEqual([]);
    });

    it("still flags a genuinely unsupported comma-grouped number", () => {
      const evidence = evidenceFor([makeItem("github", { title: "repo", stars: 100, forks: 10 })]);
      const out = output({ highlights: [hl(evidence[0].itemId, "This repo has 999,999 stars.")] });
      const issues = validateBriefingSynthesisGrounding(out, evidence);
      expect(issues.some((i) => i.severity === "warning" && i.message.includes("999999"))).toBe(true);
    });

    it("treats a comma-space list ('128, 379 items') as two separate numbers, not one grouped number", () => {
      const evidence = evidenceFor([makeItem("news", { title: "t", description: "128 repos and 379 issues tracked." })]);
      const out = output({ highlights: [hl(evidence[0].itemId, "There were 128, 379 items in total.")] });
      const issues = validateBriefingSynthesisGrounding(out, evidence);
      // Both "128" and "379" independently appear in evidence, so neither
      // half of the (correctly NOT grouped) list should be flagged.
      expect(issues.filter((i) => i.severity === "warning")).toEqual([]);
    });
  });
});
