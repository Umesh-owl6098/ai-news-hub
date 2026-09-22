import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiEmbeddingProvider } from "./openaiEmbeddingProvider";
import { EmbeddingProviderError } from "./embeddingTypes";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function embeddingsResponse(vectors: number[][], usage?: { prompt_tokens?: number }) {
  return jsonResponse(200, {
    data: vectors.map((embedding, index) => ({ embedding, index })),
    model: "test-embedding-model",
    ...(usage ? { usage } : {}),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOpenAiEmbeddingProvider — response handling and error classification", () => {
  it("returns embeddings with dimensions derived from the actual vector length", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(embeddingsResponse([[0.1, 0.2, 0.3]])));
    const provider = createOpenAiEmbeddingProvider("fake-key", "test-embedding-model");
    const result = await provider.embed(["some text"]);
    expect(result.embeddings).toEqual([{ embedding: [0.1, 0.2, 0.3], dimensions: 3 }]);
  });

  it("returns one embedding per input text, in the same order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(embeddingsResponse([[1, 0], [0, 1], [1, 1]]))
    );
    const provider = createOpenAiEmbeddingProvider("fake-key", "test-embedding-model");
    const result = await provider.embed(["a", "b", "c"]);
    expect(result.embeddings.map((e) => e.embedding)).toEqual([[1, 0], [0, 1], [1, 1]]);
  });

  it("re-orders by the response's own `index` field rather than trusting array order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          data: [
            { embedding: [2, 2], index: 1 },
            { embedding: [1, 1], index: 0 },
          ],
        })
      )
    );
    const provider = createOpenAiEmbeddingProvider("fake-key", "test-embedding-model");
    const result = await provider.embed(["first", "second"]);
    expect(result.embeddings.map((e) => e.embedding)).toEqual([[1, 1], [2, 2]]);
  });

  it("extracts usage token counts when the response includes them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(embeddingsResponse([[0.1]], { prompt_tokens: 12 })));
    const provider = createOpenAiEmbeddingProvider("fake-key", "test-embedding-model");
    const result = await provider.embed(["text"]);
    expect(result.usage).toEqual({ inputTokens: 12 });
  });

  it("omits usage rather than fabricating it when the response has none", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(embeddingsResponse([[0.1]])));
    const provider = createOpenAiEmbeddingProvider("fake-key", "test-embedding-model");
    const result = await provider.embed(["text"]);
    expect(result.usage).toBeUndefined();
  });

  it("returns an empty result for an empty input array without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenAiEmbeddingProvider("fake-key", "test-embedding-model");
    const result = await provider.embed([]);
    expect(result.embeddings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a batch larger than the provider's hard cap without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenAiEmbeddingProvider("fake-key", "test-embedding-model");
    const tooMany = Array.from({ length: 101 }, (_, i) => `text ${i}`);
    await expect(provider.embed(tooMany)).rejects.toBeInstanceOf(EmbeddingProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies HTTP 429 as rate_limited", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" })));
    const provider = createOpenAiEmbeddingProvider("fake-key", "test-embedding-model");
    await expect(provider.embed(["text"])).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("classifies a non-2xx, non-429 response as provider_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" })));
    const provider = createOpenAiEmbeddingProvider("fake-key", "test-embedding-model");
    await expect(provider.embed(["text"])).rejects.toMatchObject({ code: "provider_error" });
  });

  it("classifies malformed JSON as invalid_output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));
    const provider = createOpenAiEmbeddingProvider("fake-key", "test-embedding-model");
    await expect(provider.embed(["text"])).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("classifies a response missing the expected shape as invalid_output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { unexpected: true })));
    const provider = createOpenAiEmbeddingProvider("fake-key", "test-embedding-model");
    await expect(provider.embed(["text"])).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("classifies a vector-count mismatch (fewer results than inputs) as invalid_output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(embeddingsResponse([[0.1]])));
    const provider = createOpenAiEmbeddingProvider("fake-key", "test-embedding-model");
    await expect(provider.embed(["text one", "text two"])).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("classifies a network failure before any response as provider_error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const provider = createOpenAiEmbeddingProvider("fake-key", "test-embedding-model");
    await expect(provider.embed(["text"])).rejects.toMatchObject({ code: "provider_error" });
  });

  it("sends the configured model and the exact input texts in the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(embeddingsResponse([[0.1], [0.2]]));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenAiEmbeddingProvider("fake-key", "text-embedding-test-model");
    await provider.embed(["alpha", "beta"]);

    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(requestInit.body as string);
    expect(body).toEqual({ model: "text-embedding-test-model", input: ["alpha", "beta"] });
  });

  it("never sends the API key anywhere but the Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(embeddingsResponse([[0.1]]));
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenAiEmbeddingProvider("super-secret-key", "test-embedding-model");
    await provider.embed(["text"]);

    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit.headers.authorization).toBe("Bearer super-secret-key");
    expect(requestInit.body as string).not.toContain("super-secret-key");
  });
});

describe("createOpenAiEmbeddingProvider — Step 27B AI egress guard", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("refuses to call OpenAI when AI_EGRESS_DISABLED=1, even with a valid-looking API key — zero fetch calls", async () => {
    process.env.AI_EGRESS_DISABLED = "1";
    const fetchMock = vi.fn().mockResolvedValue(embeddingsResponse([[0.1, 0.2, 0.3]]));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAiEmbeddingProvider("sk-fake-valid-looking-key", "text-embedding-test-model");
    await expect(provider.embed(["some text"])).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("refuses even for an empty batch — the guard is checked before the empty-batch no-op", async () => {
    process.env.AI_EGRESS_DISABLED = "1";
    const fetchMock = vi.fn().mockResolvedValue(embeddingsResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAiEmbeddingProvider("sk-fake-valid-looking-key", "text-embedding-test-model");
    await expect(provider.embed([])).rejects.toMatchObject({ code: "not_configured" });
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it("flag absent leaves existing mocked-provider behavior unchanged", async () => {
    delete process.env.AI_EGRESS_DISABLED;
    const fetchMock = vi.fn().mockResolvedValue(embeddingsResponse([[0.1, 0.2, 0.3]]));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenAiEmbeddingProvider("fake-key", "test-embedding-model");
    const result = await provider.embed(["some text"]);
    expect(result.embeddings).toEqual([{ embedding: [0.1, 0.2, 0.3], dimensions: 3 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
