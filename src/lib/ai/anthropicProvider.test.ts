import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "./anthropicProvider";
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("createAnthropicProvider — response handling and error classification", () => {
  it("returns validated output for a well-formed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          content: [{ type: "text", text: JSON.stringify({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 0.6 }) }],
        })
      )
    );
    const provider = createAnthropicProvider("fake-key");
    const result = await provider.enrichArticle(input);
    expect(result.output).toEqual({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 0.6 });
  });

  it("extracts usage token counts when the response includes them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          content: [{ type: "text", text: JSON.stringify({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 0.6 }) }],
          usage: { input_tokens: 321, output_tokens: 42 },
        })
      )
    );
    const provider = createAnthropicProvider("fake-key");
    const result = await provider.enrichArticle(input);
    expect(result.usage).toEqual({ inputTokens: 321, outputTokens: 42 });
  });

  it("omits usage rather than fabricating it when the response has none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          content: [{ type: "text", text: JSON.stringify({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 0.6 }) }],
        })
      )
    );
    const provider = createAnthropicProvider("fake-key");
    const result = await provider.enrichArticle(input);
    expect(result.usage).toBeUndefined();
  });

  it("strips an optional markdown JSON code fence before parsing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          content: [
            { type: "text", text: "```json\n" + JSON.stringify({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 0.4 }) + "\n```" },
          ],
        })
      )
    );
    const provider = createAnthropicProvider("fake-key");
    const result = await provider.enrichArticle(input);
    expect(result.output.summary).toBe("Fine.");
  });

  it("classifies HTTP 429 as rate_limited", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" })));
    const provider = createAnthropicProvider("fake-key");
    await expect(provider.enrichArticle(input)).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("classifies a non-2xx, non-429 response as provider_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" })));
    const provider = createAnthropicProvider("fake-key");
    await expect(provider.enrichArticle(input)).rejects.toMatchObject({ code: "provider_error" });
  });

  it("classifies a 401 as provider_error (never retried by the service layer)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "invalid api key" })));
    const provider = createAnthropicProvider("bad-key");
    await expect(provider.enrichArticle(input)).rejects.toMatchObject({ code: "provider_error" });
  });

  it("classifies model output that isn't valid JSON as invalid_output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { content: [{ type: "text", text: "not json at all" }] }))
    );
    const provider = createAnthropicProvider("fake-key");
    await expect(provider.enrichArticle(input)).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("classifies JSON that fails schema validation (e.g. an invented topic) as invalid_output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          content: [{ type: "text", text: JSON.stringify({ summary: "Fine.", topics: ["Web3"], relevanceScore: 0.5 }) }],
        })
      )
    );
    const provider = createAnthropicProvider("fake-key");
    await expect(provider.enrichArticle(input)).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("classifies a relevanceScore out of range as invalid_output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          content: [{ type: "text", text: JSON.stringify({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 5 }) }],
        })
      )
    );
    const provider = createAnthropicProvider("fake-key");
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
    const provider = createAnthropicProvider("fake-key");
    await expect(provider.enrichArticle(input)).rejects.toMatchObject({ code: "timeout" });
  });

  it("classifies a raw network failure as provider_error, never leaking the underlying error object", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.anthropic.com")));
    const provider = createAnthropicProvider("fake-key");
    try {
      await provider.enrichArticle(input);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).message).not.toContain("ENOTFOUND");
    }
  });

  it("never sends the API key anywhere but the request header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        content: [{ type: "text", text: JSON.stringify({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 0.5 }) }],
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createAnthropicProvider("super-secret-key");
    await provider.enrichArticle(input);

    const [, requestOptions] = fetchMock.mock.calls[0];
    expect(requestOptions.headers["x-api-key"]).toBe("super-secret-key");
    expect(requestOptions.body).not.toContain("super-secret-key");
  });
});

describe("createAnthropicProvider — Step 27B AI egress guard", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("refuses to call Anthropic when AI_EGRESS_DISABLED=1, even with a valid-looking API key — zero fetch calls", async () => {
    process.env.AI_EGRESS_DISABLED = "1";
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        content: [{ type: "text", text: JSON.stringify({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 0.5 }) }],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createAnthropicProvider("sk-ant-fake-valid-looking-key");
    await expect(provider.enrichArticle(input)).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("flag absent leaves existing mocked-provider behavior unchanged", async () => {
    delete process.env.AI_EGRESS_DISABLED;
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        content: [{ type: "text", text: JSON.stringify({ summary: "Fine.", topics: ["LLMs"], relevanceScore: 0.5 }) }],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createAnthropicProvider("fake-key");
    const result = await provider.enrichArticle(input);
    expect(result.output.summary).toBe("Fine.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
