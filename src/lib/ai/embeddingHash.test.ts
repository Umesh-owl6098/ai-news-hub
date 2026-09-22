import { describe, expect, it } from "vitest";
import { computeEmbeddingInputHash } from "./embeddingHash";

describe("computeEmbeddingInputHash", () => {
  it("is deterministic: identical inputs produce identical hashes", () => {
    const a = computeEmbeddingInputHash("some document text", "text-embedding-3-small", 1);
    const b = computeEmbeddingInputHash("some document text", "text-embedding-3-small", 1);
    expect(a).toBe(b);
  });

  it("changes when the semantic document content changes", () => {
    const a = computeEmbeddingInputHash("document A", "text-embedding-3-small", 1);
    const b = computeEmbeddingInputHash("document B", "text-embedding-3-small", 1);
    expect(a).not.toBe(b);
  });

  it("changes when the embedding model changes, even with identical content", () => {
    const a = computeEmbeddingInputHash("same document", "model-a", 1);
    const b = computeEmbeddingInputHash("same document", "model-b", 1);
    expect(a).not.toBe(b);
  });

  it("changes when the embedding schema version changes, even with identical content and model", () => {
    const a = computeEmbeddingInputHash("same document", "text-embedding-3-small", 1);
    const b = computeEmbeddingInputHash("same document", "text-embedding-3-small", 2);
    expect(a).not.toBe(b);
  });

  it("produces a 64-character lowercase hex sha256 digest", () => {
    const hash = computeEmbeddingInputHash("doc", "model", 1);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is not affected by field-order tricks (fixed canonical shape, not a generic stringify)", () => {
    // computeEmbeddingInputHash takes positional args, not an object, so
    // there is no ambiguous key ordering to begin with — this test
    // documents that guarantee rather than probing for a bug that the
    // function signature already rules out.
    const a = computeEmbeddingInputHash("doc", "model", 1);
    const b = computeEmbeddingInputHash("doc", "model", 1);
    expect(a).toBe(b);
  });
});
