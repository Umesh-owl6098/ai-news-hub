import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runBriefingSynthesisEvaluation } from "@/lib/ai/briefingSynthesisOrchestration";
import { createMockBriefingSynthesisProvider } from "@/lib/ai/briefingSynthesisProvider";
import { buildBriefingEvidence } from "@/lib/ai/briefingSynthesisEvidence";
import { ProviderError } from "@/lib/ai/types";
import type { BriefingSections } from "@/lib/briefing";
import type { FeedItem } from "@/types/feed";
import type { BriefingSynthesisProvider } from "@/lib/ai/briefingSynthesisProvider";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "briefing-synthesis-orch-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeFeedItem(id: string): FeedItem {
  return {
    id,
    sourceType: "github",
    sourceName: "GitHub",
    title: `Title ${id}`,
    description: "desc",
    publishedAt: "2026-09-17T00:00:00.000Z",
    tags: [],
    score: 0,
    commentCount: 0,
    url: `https://example.com/${id}`,
  };
}

function makeEvidence(id = "github:1") {
  const sections: BriefingSections = { topStories: [makeFeedItem(id)], research: [], projects: [], newsAndDiscussion: [] };
  return buildBriefingEvidence(sections);
}

/** A provider whose call is instrumented with a spy, so tests can assert
 * exactly how many times (if any) the "network" was actually reached. */
function spiedMockProvider(): { provider: BriefingSynthesisProvider; synthesizeSpy: ReturnType<typeof vi.fn> } {
  const base = createMockBriefingSynthesisProvider();
  const synthesizeSpy = vi.fn(base.synthesize);
  return { provider: { name: base.name, model: base.model, synthesize: synthesizeSpy }, synthesizeSpy };
}

describe("runBriefingSynthesisEvaluation — caching", () => {
  it("calls the provider exactly once on a cache miss and writes a cache entry", async () => {
    const dir = await makeTempDir();
    const evidence = makeEvidence();
    const { provider, synthesizeSpy } = spiedMockProvider();

    const result = await runBriefingSynthesisEvaluation(evidence, { provider, cacheDir: dir });

    expect(synthesizeSpy).toHaveBeenCalledTimes(1);
    expect(result.cacheHit).toBe(false);
    expect(result.realCallCount).toBe(1);
  });

  it("makes ZERO provider calls on a normal re-run against unchanged evidence (cache hit)", async () => {
    const dir = await makeTempDir();
    const evidence = makeEvidence();
    const first = spiedMockProvider();
    await runBriefingSynthesisEvaluation(evidence, { provider: first.provider, cacheDir: dir });

    const second = spiedMockProvider();
    const result = await runBriefingSynthesisEvaluation(evidence, { provider: second.provider, cacheDir: dir });

    expect(second.synthesizeSpy).not.toHaveBeenCalled();
    expect(result.cacheHit).toBe(true);
    expect(result.realCallCount).toBe(0);
  });

  it("--force bypasses the cache and calls the provider again", async () => {
    const dir = await makeTempDir();
    const evidence = makeEvidence();
    const first = spiedMockProvider();
    await runBriefingSynthesisEvaluation(evidence, { provider: first.provider, cacheDir: dir });

    const second = spiedMockProvider();
    const result = await runBriefingSynthesisEvaluation(evidence, { provider: second.provider, cacheDir: dir, force: true });

    expect(second.synthesizeSpy).toHaveBeenCalledTimes(1);
    expect(result.cacheHit).toBe(false);
    expect(result.realCallCount).toBe(1);
  });

  it("a different evidence hash (different evidence) is never served from another evidence's cache entry", async () => {
    const dir = await makeTempDir();
    const evidenceA = makeEvidence("github:1");
    const evidenceB = makeEvidence("github:2");

    const first = spiedMockProvider();
    await runBriefingSynthesisEvaluation(evidenceA, { provider: first.provider, cacheDir: dir });

    const second = spiedMockProvider();
    const result = await runBriefingSynthesisEvaluation(evidenceB, { provider: second.provider, cacheDir: dir });

    expect(second.synthesizeSpy).toHaveBeenCalledTimes(1);
    expect(result.cacheHit).toBe(false);
  });
});

describe("runBriefingSynthesisEvaluation — cost/usage capture", () => {
  it("threads usage and computes cost when the provider reports token counts", async () => {
    const dir = await makeTempDir();
    const evidence = makeEvidence();
    const provider: BriefingSynthesisProvider = {
      name: "test",
      model: "gpt-5.6-luna",
      async synthesize() {
        return {
          output: {
            headline: "h",
            overview: "o",
            highlights: [{ itemId: evidence[0].itemId, summary: "s", whyItMatters: null }],
            connections: null,
          },
          usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        };
      },
    };

    const result = await runBriefingSynthesisEvaluation(evidence, { provider, cacheDir: dir });

    expect(result.entry.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    // gpt-5.6-luna pricing: $0.2/M input + $1.2/M output (pricing.ts) = $1.40 for 1M/1M.
    expect(result.entry.estimatedCostUsd).toBeCloseTo(1.4, 5);
  });

  it("reports cost as null when the model has no verified pricing entry", async () => {
    const dir = await makeTempDir();
    const evidence = makeEvidence();
    const provider: BriefingSynthesisProvider = {
      name: "test",
      model: "some-unpriced-model",
      async synthesize() {
        return {
          output: {
            headline: "h",
            overview: "o",
            highlights: [{ itemId: evidence[0].itemId, summary: "s", whyItMatters: null }],
            connections: null,
          },
          usage: { inputTokens: 100, outputTokens: 100 },
        };
      },
    };

    const result = await runBriefingSynthesisEvaluation(evidence, { provider, cacheDir: dir });
    expect(result.entry.estimatedCostUsd).toBeNull();
  });
});

describe("runBriefingSynthesisEvaluation — grounding is recorded", () => {
  it("records grounding issues found against the actual evidence used", async () => {
    const dir = await makeTempDir();
    const evidence = makeEvidence();
    const provider: BriefingSynthesisProvider = {
      name: "test",
      model: "gpt-5.6-luna",
      async synthesize() {
        return {
          output: { headline: "h", overview: "o", highlights: [{ itemId: "not-real", summary: "s", whyItMatters: null }], connections: null },
        };
      },
    };

    const result = await runBriefingSynthesisEvaluation(evidence, { provider, cacheDir: dir });
    expect(result.entry.groundingIssues.some((i) => i.severity === "error")).toBe(true);
  });
});

describe("runBriefingSynthesisEvaluation — provider failure", () => {
  it("propagates a ProviderError rather than caching a partial/failed result", async () => {
    const dir = await makeTempDir();
    const evidence = makeEvidence();
    const provider: BriefingSynthesisProvider = {
      name: "test",
      model: "gpt-5.6-luna",
      async synthesize() {
        throw new ProviderError("rate_limited", "OpenAI rate limit reached.");
      },
    };

    await expect(runBriefingSynthesisEvaluation(evidence, { provider, cacheDir: dir })).rejects.toBeInstanceOf(ProviderError);

    // A failed call must not leave a cache entry behind (nothing to hit next time).
    const dir2 = dir;
    const secondAttempt = spiedMockProvider();
    const result = await runBriefingSynthesisEvaluation(evidence, { provider: secondAttempt.provider, cacheDir: dir2 });
    expect(secondAttempt.synthesizeSpy).toHaveBeenCalledTimes(1);
    expect(result.cacheHit).toBe(false);
  });
});
