import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

function clearProviderEnv() {
  delete process.env.AI_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_ENRICHMENT_MODEL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_ENRICHMENT_MODEL;
  delete process.env.AI_EGRESS_DISABLED;
}

describe("getAiProvider", () => {
  it("returns null when nothing is configured — provider disabled, never throws", async () => {
    clearProviderEnv();
    const { getAiProvider } = await import("./provider");
    expect(getAiProvider()).toBeNull();
  });

  it("returns a configured Anthropic provider when ANTHROPIC_API_KEY is set and AI_PROVIDER is unset (Step 9 backward compatibility)", async () => {
    clearProviderEnv();
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    const { getAiProvider } = await import("./provider");
    const provider = getAiProvider();
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe("anthropic");
  });

  it("honors an explicit Anthropic model override without requiring code changes", async () => {
    clearProviderEnv();
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    process.env.ANTHROPIC_ENRICHMENT_MODEL = "claude-custom-model";
    const { getAiProvider } = await import("./provider");
    expect(getAiProvider()?.model).toBe("claude-custom-model");
  });

  it("selects the OpenAI provider when AI_PROVIDER=openai with a key and model configured", async () => {
    clearProviderEnv();
    process.env.AI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key-not-real";
    process.env.OPENAI_ENRICHMENT_MODEL = "gpt-test-model";
    const { getAiProvider } = await import("./provider");
    const provider = getAiProvider();
    expect(provider?.name).toBe("openai");
    expect(provider?.model).toBe("gpt-test-model");
  });

  it("never guesses a default OpenAI model — returns null when OPENAI_ENRICHMENT_MODEL is missing", async () => {
    clearProviderEnv();
    process.env.AI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "test-key-not-real";
    const { getAiProvider } = await import("./provider");
    expect(getAiProvider()).toBeNull();
  });

  it("returns null when AI_PROVIDER=openai but OPENAI_API_KEY is missing, even if a model is set", async () => {
    clearProviderEnv();
    process.env.AI_PROVIDER = "openai";
    process.env.OPENAI_ENRICHMENT_MODEL = "gpt-test-model";
    const { getAiProvider } = await import("./provider");
    expect(getAiProvider()).toBeNull();
  });

  it("does not fall back to Anthropic when AI_PROVIDER=openai is only partially configured", async () => {
    clearProviderEnv();
    process.env.AI_PROVIDER = "openai";
    process.env.ANTHROPIC_API_KEY = "test-key-not-real"; // present, but must not be used
    const { getAiProvider } = await import("./provider");
    expect(getAiProvider()).toBeNull();
  });

  it("returns null for an unrecognized AI_PROVIDER value rather than guessing", async () => {
    clearProviderEnv();
    process.env.AI_PROVIDER = "some-future-provider";
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    const { getAiProvider } = await import("./provider");
    expect(getAiProvider()).toBeNull();
  });
});

describe("getAiProvider — Step 27B AI egress guard", () => {
  it("returns null when AI_EGRESS_DISABLED=1, even with valid-looking Anthropic credentials present", async () => {
    clearProviderEnv();
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake-valid-looking-key";
    process.env.AI_EGRESS_DISABLED = "1";
    const { getAiProvider } = await import("./provider");
    expect(getAiProvider()).toBeNull();
  });

  it("returns null when AI_EGRESS_DISABLED=1, even with valid-looking OpenAI credentials present", async () => {
    clearProviderEnv();
    process.env.AI_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-fake-valid-looking-key";
    process.env.OPENAI_ENRICHMENT_MODEL = "gpt-test-model";
    process.env.AI_EGRESS_DISABLED = "1";
    const { getAiProvider } = await import("./provider");
    expect(getAiProvider()).toBeNull();
  });

  it("takes precedence over credentials regardless of which is set first", async () => {
    clearProviderEnv();
    process.env.AI_EGRESS_DISABLED = "1";
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake-valid-looking-key";
    const { getAiProvider } = await import("./provider");
    expect(getAiProvider()).toBeNull();
  });

  it("flag absent (undefined) leaves existing mocked-provider behavior unchanged", async () => {
    clearProviderEnv();
    delete process.env.AI_EGRESS_DISABLED;
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    const { getAiProvider } = await import("./provider");
    const provider = getAiProvider();
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe("anthropic");
  });

  it("an unrecognized value (not exactly \"1\") does not disable egress — must be explicit", async () => {
    clearProviderEnv();
    process.env.AI_EGRESS_DISABLED = "true"; // not the documented "1"
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    const { getAiProvider } = await import("./provider");
    expect(getAiProvider()).not.toBeNull();
  });
});
