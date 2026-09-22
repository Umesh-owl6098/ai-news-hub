import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiProvider } from "./openaiProvider";
import { ProviderError } from "./types";
import type { ArticleEnrichmentInput } from "./types";

const input: ArticleEnrichmentInput = {
  title: "New agent framework released",
  sourceName: "Hacker News",
  summary: "A team released an open source framework for building LLM agents.",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function messageResponse(payload: unknown, usage?: { input_tokens?: number; output_tokens?: number }) {
  return jsonResponse(200, {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(payload) }] }],
    ...(usage ? { usage } : {}),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createOpenAiProvider — response handling and error classification", () => {
  it("returns validated output for a well-formed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(messageResponse({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 0.6 }))
    );
    const provider = createOpenAiProvider("fake-key", "gpt-test-model");
    const result = await provider.enrichArticle(input);
    expect(result.output).toEqual({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 0.6 });
  });

  it("extracts usage token counts when the response includes them", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          messageResponse({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 0.6 }, { input_tokens: 200, output_tokens: 30 })
        )
    );
    const provider = createOpenAiProvider("fake-key", "gpt-test-model");
    const result = await provider.enrichArticle(input);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 30 });
  });

  it("omits usage rather than fabricating it when the response has none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(messageResponse({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 0.6 }))
    );
    const provider = createOpenAiProvider("fake-key", "gpt-test-model");
    const result = await provider.enrichArticle(input);
    expect(result.usage).toBeUndefined();
  });

  it("classifies HTTP 429 as rate_limited", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" })));
    const provider = createOpenAiProvider("fake-key", "gpt-test-model");
    await expect(provider.enrichArticle(input)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("classifies a non-2xx, non-429 response as provider_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" })));
    const provider = createOpenAiProvider("fake-key", "gpt-test-model");
    await expect(provider.enrichArticle(input)).rejects.toMatchObject({ code: "provider_error" });
  });

  it("classifies a 401 (invalid key) as provider_error, never retried by the service layer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "invalid api key" })));
    const provider = createOpenAiProvider("bad-key", "gpt-test-model");
    await expect(provider.enrichArticle(input)).rejects.toMatchObject({ code: "provider_error" });
  });

  it("classifies a missing output_text block (e.g. a refusal) as invalid_output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          status: "completed",
          output: [{ type: "message", content: [{ type: "refusal", text: "I can't help with that." }] }],
        })
      )
    );
    const provider = createOpenAiProvider("fake-key", "gpt-test-model");
    await expect(provider.enrichArticle(input)).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("classifies model output that isn't valid JSON as invalid_output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "not json at all" }] }],
        })
      )
    );
    const provider = createOpenAiProvider("fake-key", "gpt-test-model");
    await expect(provider.enrichArticle(input)).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("classifies JSON that fails schema validation (e.g. an invented topic) as invalid_output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(messageResponse({ summary: "Fine.", topics: ["Web3"], relevanceScore: 0.5 })));
    const provider = createOpenAiProvider("fake-key", "gpt-test-model");
    await expect(provider.enrichArticle(input)).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("classifies a relevanceScore out of range as invalid_output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(messageResponse({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 5 })));
    const provider = createOpenAiProvider("fake-key", "gpt-test-model");
    await expect(provider.enrichArticle(input)).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("classifies a network-level abort/timeout as timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        const err = new Error("aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      })
    );
    const provider = createOpenAiProvider("fake-key", "gpt-test-model");
    await expect(provider.enrichArticle(input)).rejects.toMatchObject({ code: "timeout" });
  });

  it("classifies a raw network failure as provider_error, never leaking the underlying error object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.openai.com")));
    const provider = createOpenAiProvider("fake-key", "gpt-test-model");
    try {
      await provider.enrichArticle(input);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).message).not.toContain("ENOTFOUND");
    }
  });

  it("sends the key only via the Authorization header, never in the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(messageResponse({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 0.5 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenAiProvider("super-secret-key", "gpt-test-model");
    await provider.enrichArticle(input);

    const [, requestOptions] = fetchMock.mock.calls[0];
    expect(requestOptions.headers.authorization).toBe("Bearer super-secret-key");
    expect(requestOptions.body).not.toContain("super-secret-key");
  });

  it("requests strict JSON-schema structured output, not free-form text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(messageResponse({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 0.5 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenAiProvider("fake-key", "gpt-test-model");
    await provider.enrichArticle(input);

    const [, requestOptions] = fetchMock.mock.calls[0];
    const body = JSON.parse(requestOptions.body as string);
    expect(body.text.format.type).toBe("json_schema");
    expect(body.text.format.strict).toBe(true);
    expect(body.model).toBe("gpt-test-model");
  });
});

describe("createOpenAiProvider — Step 27B AI egress guard", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("refuses to call OpenAI when AI_EGRESS_DISABLED=1, even with a valid-looking API key — zero fetch calls", async () => {
    process.env.AI_EGRESS_DISABLED = "1";
    const fetchMock = vi.fn().mockResolvedValue(messageResponse({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 0.5 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAiProvider("sk-fake-valid-looking-key", "gpt-test-model");
    await expect(provider.enrichArticle(input)).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("flag absent leaves existing mocked-provider behavior unchanged", async () => {
    delete process.env.AI_EGRESS_DISABLED;
    const fetchMock = vi.fn().mockResolvedValue(messageResponse({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 0.5 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAiProvider("fake-key", "gpt-test-model");
    const result = await provider.enrichArticle(input);
    expect(result.output.summary).toBe("Fine.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
