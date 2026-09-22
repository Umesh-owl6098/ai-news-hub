import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCachedBriefingSynthesis, writeCachedBriefingSynthesis, type CachedBriefingSynthesis } from "@/lib/ai/briefingSynthesisCache";
import type { BriefingSynthesisOutput } from "@/lib/ai/briefingSynthesisSchema";

function makeOutput(headline: string, itemId: string): BriefingSynthesisOutput {
  return { headline, overview: "o", highlights: [{ itemId, summary: "s", whyItMatters: null }], connections: null };
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "briefing-synthesis-cache-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeEntry(overrides: Partial<CachedBriefingSynthesis> = {}): CachedBriefingSynthesis {
  return {
    evidenceHash: "abc123",
    model: "gpt-5.6-luna",
    promptVersion: "briefing-synthesis-v1",
    generatedAt: "2026-09-17T00:00:00.000Z",
    output: makeOutput("h", "x:1"),
    usage: { inputTokens: 100, outputTokens: 50 },
    estimatedCostUsd: 0.0001,
    latencyMs: 500,
    groundingIssues: [],
    ...overrides,
  };
}

describe("briefingSynthesisCache", () => {
  it("returns null on a cache miss", async () => {
    const dir = await makeTempDir();
    expect(await readCachedBriefingSynthesis("nonexistent-hash", dir)).toBeNull();
  });

  it("round-trips a written entry", async () => {
    const dir = await makeTempDir();
    const entry = makeEntry();
    await writeCachedBriefingSynthesis(entry, dir);
    const read = await readCachedBriefingSynthesis(entry.evidenceHash, dir);
    expect(read).toEqual(entry);
  });

  it("keys distinct entries by evidence hash independently", async () => {
    const dir = await makeTempDir();
    const a = makeEntry({ evidenceHash: "hash-a", output: makeOutput("A", "x:1") });
    const b = makeEntry({ evidenceHash: "hash-b", output: makeOutput("B", "x:2") });
    await writeCachedBriefingSynthesis(a, dir);
    await writeCachedBriefingSynthesis(b, dir);

    expect((await readCachedBriefingSynthesis("hash-a", dir))?.output.headline).toBe("A");
    expect((await readCachedBriefingSynthesis("hash-b", dir))?.output.headline).toBe("B");
  });

  it("returns null rather than throwing when the cache directory doesn't exist yet", async () => {
    const dir = path.join(tmpdir(), "briefing-synthesis-cache-test-never-created");
    expect(await readCachedBriefingSynthesis("any-hash", dir)).toBeNull();
  });
});
