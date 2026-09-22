import { afterEach, describe, expect, it } from "vitest";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function clearEmbeddingProviderEnv() {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_EMBEDDING_MODEL;
  delete process.env.AI_EGRESS_DISABLED;
}

describe("getEmbeddingProvider", () => {
  it("returns null when nothing is configured — embeddings disabled, never throws", async () => {
    clearEmbeddingProviderEnv();
    const { getEmbeddingProvider } = await import("./embeddingProvider");
    expect(getEmbeddingProvider()).toBeNull();
  });

  it("returns a configured provider when both OPENAI_API_KEY and OPENAI_EMBEDDING_MODEL are set", async () => {
    clearEmbeddingProviderEnv();
    process.env.OPENAI_API_KEY = "sk-fake-valid-looking-key";
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
    const { getEmbeddingProvider } = await import("./embeddingProvider");
    const provider = getEmbeddingProvider();
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe("openai");
    expect(provider?.model).toBe("text-embedding-3-small");
  });

  it("never guesses a model — returns null when OPENAI_EMBEDDING_MODEL is missing", async () => {
    clearEmbeddingProviderEnv();
    process.env.OPENAI_API_KEY = "sk-fake-valid-looking-key";
    const { getEmbeddingProvider } = await import("./embeddingProvider");
    expect(getEmbeddingProvider()).toBeNull();
  });
});

describe("getEmbeddingProvider — Step 27B AI egress guard", () => {
  it("returns null when AI_EGRESS_DISABLED=1, even with valid-looking credentials present", async () => {
    clearEmbeddingProviderEnv();
    process.env.OPENAI_API_KEY = "sk-fake-valid-looking-key";
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
    process.env.AI_EGRESS_DISABLED = "1";
    const { getEmbeddingProvider } = await import("./embeddingProvider");
    expect(getEmbeddingProvider()).toBeNull();
  });

  it("takes precedence over credentials regardless of which is set first", async () => {
    clearEmbeddingProviderEnv();
    process.env.AI_EGRESS_DISABLED = "1";
    process.env.OPENAI_API_KEY = "sk-fake-valid-looking-key";
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
    const { getEmbeddingProvider } = await import("./embeddingProvider");
    expect(getEmbeddingProvider()).toBeNull();
  });

  it("flag absent (undefined) leaves existing mocked-provider behavior unchanged", async () => {
    clearEmbeddingProviderEnv();
    delete process.env.AI_EGRESS_DISABLED;
    process.env.OPENAI_API_KEY = "sk-fake-valid-looking-key";
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
    const { getEmbeddingProvider } = await import("./embeddingProvider");
    expect(getEmbeddingProvider()).not.toBeNull();
  });

  it("an unrecognized value (not exactly \"1\") does not disable egress — must be explicit", async () => {
    clearEmbeddingProviderEnv();
    process.env.AI_EGRESS_DISABLED = "yes";
    process.env.OPENAI_API_KEY = "sk-fake-valid-looking-key";
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
    const { getEmbeddingProvider } = await import("./embeddingProvider");
    expect(getEmbeddingProvider()).not.toBeNull();
  });
});
