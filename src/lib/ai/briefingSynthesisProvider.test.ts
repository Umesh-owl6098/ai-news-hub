import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMockBriefingSynthesisProvider,
  createOpenAiBriefingSynthesisProvider,
  BriefingSynthesisCallError,
} from "@/lib/ai/briefingSynthesisProvider";
import { briefingSynthesisOutputSchema, MAX_HIGHLIGHTS, MAX_CONNECTIONS } from "@/lib/ai/briefingSynthesisSchema";
import { buildBriefingEvidence } from "@/lib/ai/briefingSynthesisEvidence";
import type { BriefingSections } from "@/lib/briefing";
import type { FeedItem } from "@/types/feed";

function makeItem(id: string): FeedItem {
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

describe("createMockBriefingSynthesisProvider", () => {
  it("never makes a network call and returns a schema-valid, grounded output", async () => {
    const sections: BriefingSections = { topStories: [makeItem("a"), makeItem("b")], research: [], projects: [], newsAndDiscussion: [] };
    const evidence = buildBriefingEvidence(sections);
    const provider = createMockBriefingSynthesisProvider();

    const { output, usage } = await provider.synthesize(evidence);

    expect(briefingSynthesisOutputSchema.safeParse(output).success).toBe(true);
    // The mock never talks to a real API, so it must never fabricate usage.
    expect(usage).toBeUndefined();
    for (const h of output.highlights) {
      expect(evidence.some((e) => e.itemId === h.itemId)).toBe(true);
    }
  });

  it("is deterministic — identical evidence produces identical output", async () => {
    const sections: BriefingSections = { topStories: [makeItem("a")], research: [], projects: [], newsAndDiscussion: [] };
    const evidence = buildBriefingEvidence(sections);
    const provider = createMockBriefingSynthesisProvider();

    const first = await provider.synthesize(evidence);
    const second = await provider.synthesize(evidence);
    expect(first.output).toEqual(second.output);
  });

  it("reports its name and model for cache-key/report purposes", () => {
    const provider = createMockBriefingSynthesisProvider();
    expect(provider.name).toBe("mock");
    expect(provider.model).toBeTruthy();
  });
});

// --- Real adapter: completion-status / failure-mode matrix (Step 23C §5-7) ---
//
// Reproduces both real paid-call failures locally against a mocked
// `fetch`, plus every other branch of the Responses API result handling,
// so the exact shape of a future failure is provable without spending
// money. Mirrors openaiProvider.test.ts's mocking convention.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function messageResponse(
  payload: unknown,
  options: { status?: string; usage?: { input_tokens?: number; output_tokens?: number }; incompleteReason?: string } = {}
): Response {
  return jsonResponse(200, {
    status: options.status ?? "completed",
    ...(options.incompleteReason ? { incomplete_details: { reason: options.incompleteReason } } : {}),
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(payload) }] }],
    ...(options.usage ? { usage: options.usage } : {}),
  });
}

function evidenceOf(ids: string[]) {
  const items = ids.map((id) => makeItem(id));
  const sections: BriefingSections = { topStories: items, research: [], projects: [], newsAndDiscussion: [] };
  return buildBriefingEvidence(sections);
}

function validPayload(itemId: string) {
  return { headline: "h", overview: "o", highlights: [{ itemId, summary: "s", whyItMatters: null }], connections: null };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOpenAiBriefingSynthesisProvider — successful completion", () => {
  it("returns a schema-valid output and captures usage for a well-formed, complete response", async () => {
    const evidence = evidenceOf(["a"]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(messageResponse(validPayload("a"), { usage: { input_tokens: 500, output_tokens: 200 } }))
    );

    const provider = createOpenAiBriefingSynthesisProvider("fake-key", "gpt-5.6-luna");
    const { output, usage } = await provider.synthesize(evidence);

    expect(briefingSynthesisOutputSchema.safeParse(output).success).toBe(true);
    expect(usage).toEqual({ inputTokens: 500, outputTokens: 200 });
  });

  it("sends the derived strict JSON Schema (with maxItems/required already proven correct elsewhere) as the request's structured-output contract", async () => {
    const evidence = evidenceOf(["a"]);
    const fetchMock = vi.fn().mockResolvedValue(messageResponse(validPayload("a")));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAiBriefingSynthesisProvider("fake-key", "gpt-5.6-luna");
    await provider.synthesize(evidence);

    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(requestInit.body as string);
    expect(body.text.format.strict).toBe(true);
    expect(body.text.format.schema.properties.highlights.maxItems).toBe(MAX_HIGHLIGHTS);
    expect(body.max_output_tokens).toBe(4000);
  });
});

describe("createOpenAiBriefingSynthesisProvider — Failure A reproduced locally: truncated/incomplete response", () => {
  it("classifies an incomplete response as invalid_output with stage 'incomplete', and still captures usage", async () => {
    const evidence = evidenceOf(["a"]);
    // A truncated response: valid envelope, status incomplete, and (as
    // OpenAI's real truncated response actually was) the output_text
    // itself is cut off mid-JSON — exactly Call 1's real failure shape.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        messageResponse('{"headline": "h", "overview": "o", "highlights": [{"itemId": "a", "sum', {
          status: "incomplete",
          incompleteReason: "max_output_tokens",
          usage: { input_tokens: 6108, output_tokens: 4000 },
        })
      )
    );

    const provider = createOpenAiBriefingSynthesisProvider("fake-key", "gpt-5.6-luna");
    const error = await provider.synthesize(evidence).catch((e) => e);

    expect(error).toBeInstanceOf(BriefingSynthesisCallError);
    const callError = error as BriefingSynthesisCallError;
    expect(callError.code).toBe("invalid_output");
    expect(callError.stage).toBe("incomplete");
    expect(callError.completionStatus).toBe("incomplete");
    expect(callError.message).toContain("max_output_tokens");
    // The observability gap Call 2 exposed: usage must survive even
    // though the response never reached valid JSON.
    expect(callError.usage).toEqual({ inputTokens: 6108, outputTokens: 4000 });
    expect(callError.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("createOpenAiBriefingSynthesisProvider — Failure B reproduced locally: valid JSON exceeding the contract", () => {
  it(`rejects ${MAX_HIGHLIGHTS + 1} highlights and ${MAX_CONNECTIONS + 1} connections as invalid_output/schema_validation, downstream of a successful, complete parse`, async () => {
    const evidence = evidenceOf(["a"]);
    const oversizedPayload = {
      headline: "h",
      overview: "o",
      highlights: Array.from({ length: MAX_HIGHLIGHTS + 1 }, (_, i) => ({ itemId: "a", summary: `s${i}`, whyItMatters: null })),
      connections: Array.from({ length: MAX_CONNECTIONS + 1 }, (_, i) => ({ itemIds: ["a", "a"], observation: `o${i}` })),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(messageResponse(oversizedPayload, { usage: { input_tokens: 6108, output_tokens: 2205 } }))
    );

    const provider = createOpenAiBriefingSynthesisProvider("fake-key", "gpt-5.6-luna");
    const error = await provider.synthesize(evidence).catch((e) => e);

    expect(error).toBeInstanceOf(BriefingSynthesisCallError);
    const callError = error as BriefingSynthesisCallError;
    expect(callError.code).toBe("invalid_output");
    expect(callError.stage).toBe("schema_validation");
    expect(callError.completionStatus).toBe("completed");
    // This is the exact real-world case: a COMPLETE, valid-JSON response
    // that still violates the application's own bounds — proving usage
    // is captured even when parsing fully succeeded but validation failed.
    expect(callError.usage).toEqual({ inputTokens: 6108, outputTokens: 2205 });
  });
});

describe("createOpenAiBriefingSynthesisProvider — remaining completion/error matrix (§6)", () => {
  it("classifies malformed (non-JSON) model output as invalid_output/invalid_json", async () => {
    const evidence = evidenceOf(["a"]);
    // messageResponse() JSON.stringifies its payload, so a hand-built
    // envelope is used here instead, to get truly non-JSON output text.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "not valid json {{{" }] }],
        })
      )
    );

    const provider = createOpenAiBriefingSynthesisProvider("fake-key", "gpt-5.6-luna");
    const error = await provider.synthesize(evidence).catch((e) => e);

    expect(error).toBeInstanceOf(BriefingSynthesisCallError);
    expect((error as BriefingSynthesisCallError).stage).toBe("invalid_json");
  });

  it("classifies a response with no output_text block (e.g. a refusal) as no_output_text", async () => {
    const evidence = evidenceOf(["a"]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { status: "completed", output: [{ type: "message", content: [] }] })));

    const provider = createOpenAiBriefingSynthesisProvider("fake-key", "gpt-5.6-luna");
    const error = await provider.synthesize(evidence).catch((e) => e);

    expect(error).toBeInstanceOf(BriefingSynthesisCallError);
    expect((error as BriefingSynthesisCallError).stage).toBe("no_output_text");
  });

  it("classifies HTTP 429 as rate_limited with stage http_status and no usage (never reached the envelope)", async () => {
    const evidence = evidenceOf(["a"]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, {})));

    const provider = createOpenAiBriefingSynthesisProvider("fake-key", "gpt-5.6-luna");
    const error = await provider.synthesize(evidence).catch((e) => e);

    expect(error).toBeInstanceOf(BriefingSynthesisCallError);
    const callError = error as BriefingSynthesisCallError;
    expect(callError.code).toBe("rate_limited");
    expect(callError.stage).toBe("http_status");
    expect(callError.usage).toBeUndefined();
  });

  it("classifies a non-2xx, non-429 response as provider_error", async () => {
    const evidence = evidenceOf(["a"]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, {})));

    const provider = createOpenAiBriefingSynthesisProvider("fake-key", "gpt-5.6-luna");
    const error = await provider.synthesize(evidence).catch((e) => e);

    expect(error).toBeInstanceOf(BriefingSynthesisCallError);
    expect((error as BriefingSynthesisCallError).code).toBe("provider_error");
  });

  it("classifies a raw network failure as provider_error with stage network, latency still recorded", async () => {
    const evidence = evidenceOf(["a"]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")));

    const provider = createOpenAiBriefingSynthesisProvider("fake-key", "gpt-5.6-luna");
    const error = await provider.synthesize(evidence).catch((e) => e);

    expect(error).toBeInstanceOf(BriefingSynthesisCallError);
    const callError = error as BriefingSynthesisCallError;
    expect(callError.code).toBe("provider_error");
    expect(callError.stage).toBe("network");
    expect(callError.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("never logs or exposes the raw model output text on any failure path", async () => {
    const evidence = evidenceOf(["a"]);
    const secretLookingText = "SECRET_MARKER_zzz_not_json {{{";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: secretLookingText }] }] }))
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const provider = createOpenAiBriefingSynthesisProvider("fake-key", "gpt-5.6-luna");
    const error = await provider.synthesize(evidence).catch((e) => e);

    expect(error).toBeInstanceOf(BriefingSynthesisCallError);
    const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join(" ");
    expect(allLoggedText).not.toContain(secretLookingText);
    expect((error as BriefingSynthesisCallError).message).not.toContain(secretLookingText);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe("createOpenAiBriefingSynthesisProvider — Step 27B AI egress guard", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("refuses to call OpenAI when AI_EGRESS_DISABLED=1, even with a valid-looking API key — zero fetch calls", async () => {
    process.env.AI_EGRESS_DISABLED = "1";
    const evidence = evidenceOf(["a"]);
    const fetchMock = vi.fn().mockResolvedValue(messageResponse(validPayload("a")));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAiBriefingSynthesisProvider("sk-fake-valid-looking-key", "gpt-5.6-luna");
    const error = await provider.synthesize(evidence).catch((e) => e);

    expect(error).toBeInstanceOf(BriefingSynthesisCallError);
    expect((error as BriefingSynthesisCallError).code).toBe("not_configured");
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("flag absent leaves existing mocked-provider behavior unchanged", async () => {
    delete process.env.AI_EGRESS_DISABLED;
    const evidence = evidenceOf(["a"]);
    const fetchMock = vi.fn().mockResolvedValue(messageResponse(validPayload("a")));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAiBriefingSynthesisProvider("fake-key", "gpt-5.6-luna");
    const { output } = await provider.synthesize(evidence);
    expect(briefingSynthesisOutputSchema.safeParse(output).success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
