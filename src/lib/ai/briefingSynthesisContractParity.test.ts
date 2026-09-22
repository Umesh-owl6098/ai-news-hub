import { describe, expect, it } from "vitest";
import {
  toOpenAiStrictJsonSchema,
  briefingSynthesisOutputSchema,
  MAX_HIGHLIGHTS,
  MAX_CONNECTIONS,
  MIN_CONNECTION_ITEM_IDS,
} from "@/lib/ai/briefingSynthesisSchema";

/**
 * Step 23C §4 — proves the JSON Schema actually sent to OpenAI (via
 * `toOpenAiStrictJsonSchema`, derived from the SAME Zod schema that
 * validates the response afterward) structurally agrees with the
 * application contract. This is exactly the class of bug that caused
 * Call 2: a hand-maintained provider schema silently drifted from the
 * Zod schema it was supposed to mirror. Deriving both from one
 * definition makes that specific class of drift structurally
 * impossible — these tests exist to prove the derivation actually
 * carries the constraints through, not to guard against a human
 * forgetting to update two copies (there is only one copy now).
 */

type JsonSchemaObject = {
  type?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaObject;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  anyOf?: JsonSchemaObject[];
};

function asObject(value: unknown): JsonSchemaObject {
  return value as JsonSchemaObject;
}

/** Unwraps Zod's `anyOf: [X, {type:"null"}]` nullable representation to
 * the non-null branch, for constraint assertions that don't care about
 * nullability itself (that's asserted separately). */
function nonNullBranch(schema: JsonSchemaObject): JsonSchemaObject {
  if (!schema.anyOf) return schema;
  const nonNull = schema.anyOf.find((branch) => branch.type !== "null");
  if (!nonNull) throw new Error("expected a non-null anyOf branch");
  return nonNull;
}

describe("toOpenAiStrictJsonSchema — contract parity with the Zod schema", () => {
  const schema = toOpenAiStrictJsonSchema();

  it("has no $schema meta key (OpenAI expects a bare schema object)", () => {
    expect(schema).not.toHaveProperty("$schema");
  });

  it("requires every top-level property (OpenAI strict mode has no true optional key)", () => {
    const declaredKeys = Object.keys(asObject(schema).properties ?? {});
    expect(asObject(schema).required).toEqual(expect.arrayContaining(declaredKeys));
    expect(asObject(schema).required).toHaveLength(declaredKeys.length);
  });

  it("sets additionalProperties: false at the top level", () => {
    expect(asObject(schema).additionalProperties).toBe(false);
  });

  it(`sets highlights.maxItems === ${MAX_HIGHLIGHTS} and minItems === 1 (this exact bound was missing during Call 2)`, () => {
    const highlights = asObject(schema).properties!.highlights;
    expect(highlights.maxItems).toBe(MAX_HIGHLIGHTS);
    expect(highlights.minItems).toBe(1);
  });

  it(`sets connections.maxItems === ${MAX_CONNECTIONS} on the non-null branch (this exact bound was missing during Call 2)`, () => {
    const connections = nonNullBranch(asObject(schema).properties!.connections);
    expect(connections.maxItems).toBe(MAX_CONNECTIONS);
  });

  it(`sets connections[].itemIds.minItems === ${MIN_CONNECTION_ITEM_IDS}`, () => {
    const connections = nonNullBranch(asObject(schema).properties!.connections);
    const itemIds = connections.items!.properties!.itemIds;
    expect(itemIds.minItems).toBe(MIN_CONNECTION_ITEM_IDS);
  });

  it("requires every property on a highlight item, including whyItMatters, with additionalProperties: false", () => {
    const highlightItem = asObject(schema).properties!.highlights.items!;
    expect(highlightItem.required).toEqual(expect.arrayContaining(["itemId", "summary", "whyItMatters"]));
    expect(highlightItem.additionalProperties).toBe(false);
  });

  it("marks whyItMatters as nullable (anyOf includes a null branch) rather than omittable", () => {
    const whyItMatters = asObject(schema).properties!.highlights.items!.properties!.whyItMatters;
    expect(whyItMatters.anyOf?.some((b) => b.type === "null")).toBe(true);
  });

  it("marks connections as nullable (anyOf includes a null branch) rather than omittable", () => {
    const connections = asObject(schema).properties!.connections;
    expect(connections.anyOf?.some((b) => b.type === "null")).toBe(true);
  });

  it("requires every property on a connection item, with additionalProperties: false", () => {
    const connectionItem = nonNullBranch(asObject(schema).properties!.connections).items!;
    expect(connectionItem.required).toEqual(expect.arrayContaining(["itemIds", "observation"]));
    expect(connectionItem.additionalProperties).toBe(false);
  });

  it("string length bounds on the provider schema match the Zod schema's own bounds", () => {
    const props = asObject(schema).properties!;
    expect(props.headline.maxLength).toBe(120);
    expect(props.overview.maxLength).toBe(500);
    const highlightItem = props.highlights.items!.properties!;
    expect(highlightItem.summary.maxLength).toBe(300);
    expect(nonNullBranch(highlightItem.whyItMatters).maxLength).toBe(200);
  });

  it("does NOT (and cannot) express highlight-itemId uniqueness — that stays a downstream/semantic check", () => {
    // JSON Schema's `uniqueItems` only compares whole array elements for
    // deep equality; it cannot express "unique by one field (itemId)
    // across sibling objects that may otherwise legitimately differ."
    // Confirms the schema has no such (necessarily ineffective) keyword,
    // documenting that this constraint is intentionally NOT here.
    const highlights = asObject(schema).properties!.highlights;
    expect(highlights.items).not.toHaveProperty("uniqueItems");
  });

  it("stays in sync with the Zod schema by construction — proven by round-tripping a boundary-valid object", () => {
    // Not a snapshot of the JSON Schema itself (which would just
    // reintroduce a second copy to keep in sync) — instead, construct an
    // object at the exact documented boundary (8 highlights, 4
    // connections, min 2 itemIds) and confirm the SAME Zod schema that
    // the JSON Schema is derived from still accepts it. If a future edit
    // changes one without the other, `toOpenAiStrictJsonSchema` (which
    // reads directly from `briefingSynthesisOutputSchema`) picks up the
    // change automatically — there is no second definition to forget.
    const boundaryValid = {
      headline: "h",
      overview: "o",
      highlights: Array.from({ length: MAX_HIGHLIGHTS }, (_, i) => ({ itemId: `x:${i}`, summary: "s", whyItMatters: null })),
      connections: Array.from({ length: MAX_CONNECTIONS }, (_, i) => ({ itemIds: [`a:${i}`, `b:${i}`], observation: "o" })),
    };
    expect(briefingSynthesisOutputSchema.safeParse(boundaryValid).success).toBe(true);
  });
});
