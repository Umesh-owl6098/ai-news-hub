import { describe, expect, it } from "vitest";
import {
  briefingSynthesisOutputSchema,
  MAX_HIGHLIGHTS,
  MAX_CONNECTIONS,
  MIN_CONNECTION_ITEM_IDS,
} from "@/lib/ai/briefingSynthesisSchema";

function hl(itemId: string, summary = "s", whyItMatters: string | null = null) {
  return { itemId, summary, whyItMatters };
}

/** A minimal but COMPLETE valid output — `connections` present as `null`,
 * matching the required-but-nullable contract every real producer
 * (the OpenAI adapter, the mock provider) must satisfy. See
 * briefingSynthesisSchema.ts's module comment for why `.nullable()` (not
 * `.optional()`/`.nullish()`) is the deliberate choice here. */
function validOutput() {
  return {
    headline: "A quiet day in AI",
    overview: "A handful of new repos and one paper landed in the last window.",
    highlights: [hl("github:1", "A new inference library was published.")],
    connections: null,
  };
}

describe("briefingSynthesisOutputSchema — basic acceptance", () => {
  it("accepts a well-formed minimal output (whyItMatters and connections explicitly null)", () => {
    expect(briefingSynthesisOutputSchema.safeParse(validOutput()).success).toBe(true);
  });

  it("accepts a well-formed output with whyItMatters and connections populated", () => {
    const output = {
      ...validOutput(),
      highlights: [hl("github:1", "A new inference library.", "Speeds up local inference.")],
      connections: [{ itemIds: ["github:1", "paper:2"], observation: "Both reference the same quantization technique." }],
    };
    expect(briefingSynthesisOutputSchema.safeParse(output).success).toBe(true);
  });

  it("rejects an empty headline", () => {
    expect(briefingSynthesisOutputSchema.safeParse({ ...validOutput(), headline: "" }).success).toBe(false);
  });

  it("rejects a headline that reads like an essay, not a short line (string maxLength)", () => {
    const longHeadline = "This is a very long headline. ".repeat(10);
    expect(briefingSynthesisOutputSchema.safeParse({ ...validOutput(), headline: longHeadline }).success).toBe(false);
  });

  it("string length bounds match the documented constants (headline max 120, overview max 500)", () => {
    expect(briefingSynthesisOutputSchema.safeParse({ ...validOutput(), headline: "x".repeat(120) }).success).toBe(true);
    expect(briefingSynthesisOutputSchema.safeParse({ ...validOutput(), headline: "x".repeat(121) }).success).toBe(false);
    expect(briefingSynthesisOutputSchema.safeParse({ ...validOutput(), overview: "x".repeat(500) }).success).toBe(true);
    expect(briefingSynthesisOutputSchema.safeParse({ ...validOutput(), overview: "x".repeat(501) }).success).toBe(false);
  });
});

describe("briefingSynthesisOutputSchema — highlights bounds (§4)", () => {
  it("rejects zero highlights — every synthesis must reference at least one item", () => {
    expect(briefingSynthesisOutputSchema.safeParse({ ...validOutput(), highlights: [] }).success).toBe(false);
  });

  it(`accepts exactly ${MAX_HIGHLIGHTS} highlights`, () => {
    const highlights = Array.from({ length: MAX_HIGHLIGHTS }, (_, i) => hl(`x:${i}`));
    expect(briefingSynthesisOutputSchema.safeParse({ ...validOutput(), highlights }).success).toBe(true);
  });

  it(`rejects ${MAX_HIGHLIGHTS + 1} highlights (one over the max)`, () => {
    const highlights = Array.from({ length: MAX_HIGHLIGHTS + 1 }, (_, i) => hl(`x:${i}`));
    expect(briefingSynthesisOutputSchema.safeParse({ ...validOutput(), highlights }).success).toBe(false);
  });
});

describe("briefingSynthesisOutputSchema — connections bounds (§4)", () => {
  it(`accepts exactly ${MAX_CONNECTIONS} connections`, () => {
    const connections = Array.from({ length: MAX_CONNECTIONS }, (_, i) => ({ itemIds: [`a:${i}`, `b:${i}`], observation: "obs" }));
    expect(briefingSynthesisOutputSchema.safeParse({ ...validOutput(), connections }).success).toBe(true);
  });

  it(`rejects ${MAX_CONNECTIONS + 1} connections (one over the max)`, () => {
    const connections = Array.from({ length: MAX_CONNECTIONS + 1 }, (_, i) => ({ itemIds: [`a:${i}`, `b:${i}`], observation: "obs" }));
    expect(briefingSynthesisOutputSchema.safeParse({ ...validOutput(), connections }).success).toBe(false);
  });

  it(`accepts a connection with exactly ${MIN_CONNECTION_ITEM_IDS} itemIds`, () => {
    const output = { ...validOutput(), connections: [{ itemIds: ["a:1", "b:1"], observation: "obs" }] };
    expect(briefingSynthesisOutputSchema.safeParse(output).success).toBe(true);
  });

  it("rejects a connection with only one itemId (structurally below MIN_CONNECTION_ITEM_IDS)", () => {
    const output = { ...validOutput(), connections: [{ itemIds: ["github:1"], observation: "obs" }] };
    expect(briefingSynthesisOutputSchema.safeParse(output).success).toBe(false);
  });

  it("accepts null connections (the documented 'nothing worth connecting' case)", () => {
    expect(briefingSynthesisOutputSchema.safeParse({ ...validOutput(), connections: null }).success).toBe(true);
  });

  it(
    "does NOT structurally reject a connection whose itemIds repeat the same id twice — " +
      "distinctness is a semantic/downstream check (validateBriefingSynthesisGrounding), " +
      "not something array length alone can express",
    () => {
      const output = { ...validOutput(), connections: [{ itemIds: ["a:1", "a:1"], observation: "obs" }] };
      // Structurally valid: 2 array entries satisfies min(2). Whether they're
      // DISTINCT is checked downstream, not by this schema — see
      // briefingSynthesisEvidence.test.ts's grounding-validator tests.
      expect(briefingSynthesisOutputSchema.safeParse(output).success).toBe(true);
    }
  );
});

describe("briefingSynthesisOutputSchema — nullability (§4)", () => {
  it("accepts null whyItMatters", () => {
    const output = { ...validOutput(), highlights: [hl("github:1", "s", null)] };
    expect(briefingSynthesisOutputSchema.safeParse(output).success).toBe(true);
  });

  it("accepts a populated whyItMatters", () => {
    const output = { ...validOutput(), highlights: [hl("github:1", "s", "Because it changes local inference cost.")] };
    expect(briefingSynthesisOutputSchema.safeParse(output).success).toBe(true);
  });

  it("rejects an omitted whyItMatters key — the contract requires the key to always be present (possibly null), matching OpenAI strict mode", () => {
    const output = { ...validOutput(), highlights: [{ itemId: "github:1", summary: "s" }] };
    expect(briefingSynthesisOutputSchema.safeParse(output).success).toBe(false);
  });

  it("rejects an omitted connections key at the top level for the same reason", () => {
    const { headline, overview, highlights } = validOutput();
    expect(briefingSynthesisOutputSchema.safeParse({ headline, overview, highlights }).success).toBe(false);
  });
});

describe("briefingSynthesisOutputSchema — additionalProperties (§4)", () => {
  it("rejects an unexpected top-level property (strict mode — no silent stripping)", () => {
    const result = briefingSynthesisOutputSchema.safeParse({ ...validOutput(), extra: "not allowed" });
    expect(result.success).toBe(false);
  });

  it("rejects an unexpected property on a highlight", () => {
    const output = { ...validOutput(), highlights: [{ ...hl("github:1"), bogus: true }] };
    expect(briefingSynthesisOutputSchema.safeParse(output).success).toBe(false);
  });

  it("rejects an unexpected property on a connection", () => {
    const output = { ...validOutput(), connections: [{ itemIds: ["a:1", "b:1"], observation: "obs", bogus: true }] };
    expect(briefingSynthesisOutputSchema.safeParse(output).success).toBe(false);
  });
});
