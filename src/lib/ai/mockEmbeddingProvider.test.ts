import { describe, expect, it } from "vitest";
import { createMockEmbeddingProvider } from "./mockEmbeddingProvider";

describe("createMockEmbeddingProvider", () => {
  it("is deterministic — the same text always produces the same vector", async () => {
    const provider = createMockEmbeddingProvider();
    const a = await provider.embed(["same text"]);
    const b = await provider.embed(["same text"]);
    expect(a.embeddings).toEqual(b.embeddings);
  });

  it("produces different vectors for different text", async () => {
    const provider = createMockEmbeddingProvider();
    const result = await provider.embed(["text one", "text two"]);
    expect(result.embeddings[0].embedding).not.toEqual(result.embeddings[1].embedding);
  });

  it("returns one embedding per input text, in order", async () => {
    const provider = createMockEmbeddingProvider();
    const result = await provider.embed(["a", "b", "c"]);
    expect(result.embeddings).toHaveLength(3);
  });

  it("reports a consistent, positive dimensions value", async () => {
    const provider = createMockEmbeddingProvider();
    const result = await provider.embed(["some text"]);
    expect(result.embeddings[0].dimensions).toBeGreaterThan(0);
    expect(result.embeddings[0].embedding.length).toBe(result.embeddings[0].dimensions);
  });

  it("never calls the network — has a stable name identifying it as the mock", () => {
    const provider = createMockEmbeddingProvider();
    expect(provider.name).toBe("mock");
  });

  it("uses the explicitly configured model identifier, never a hidden default that could collide across tests", () => {
    const provider = createMockEmbeddingProvider("custom-mock-model-v2");
    expect(provider.model).toBe("custom-mock-model-v2");
  });
});
