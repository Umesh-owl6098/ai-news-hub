import { describe, expect, it } from "vitest";
import { estimateCostUsd, getPricingSource } from "./pricing";

describe("estimateCostUsd", () => {
  it("computes a cost for a model with a verified pricing entry", () => {
    const cost = estimateCostUsd("claude-haiku-4-5-20251001", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBe(1 + 5); // $1/MTok in + $5/MTok out, per the documented source
  });

  it("scales linearly with token count", () => {
    const cost = estimateCostUsd("claude-haiku-4-5-20251001", { inputTokens: 500, outputTokens: 100 });
    expect(cost).toBeCloseTo(500 / 1_000_000 + (100 / 1_000_000) * 5, 10);
  });

  it("returns null for a model with no pricing entry — never fabricates a number", () => {
    expect(estimateCostUsd("some-unlisted-model", { inputTokens: 100, outputTokens: 100 })).toBeNull();
  });

  it("returns null when usage is entirely absent", () => {
    expect(estimateCostUsd("claude-haiku-4-5-20251001", undefined)).toBeNull();
  });

  it("returns null when usage is missing either field, rather than computing a partial/misleading cost", () => {
    expect(estimateCostUsd("claude-haiku-4-5-20251001", { inputTokens: 100 })).toBeNull();
    expect(estimateCostUsd("claude-haiku-4-5-20251001", { outputTokens: 100 })).toBeNull();
  });

  it("computes a cost for gpt-5.6-luna (Step 11 OpenAI candidate)", () => {
    const cost = estimateCostUsd("gpt-5.6-luna", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.2 + 1.2, 10);
  });

  it("computes a cost for gpt-5.6-terra (Step 12 comparison candidate)", () => {
    const cost = estimateCostUsd("gpt-5.6-terra", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(2.0 + 12.0, 10);
  });
});

describe("getPricingSource", () => {
  it("returns the documented source and verification date for a known model", () => {
    const source = getPricingSource("claude-haiku-4-5-20251001");
    expect(source).not.toBeNull();
    expect(source?.source).toContain("platform.claude.com");
    expect(source?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns null for an unlisted model", () => {
    expect(getPricingSource("some-unlisted-model")).toBeNull();
  });
});
