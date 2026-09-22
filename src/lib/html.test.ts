import { describe, expect, it } from "vitest";
import { htmlToPlainText } from "@/lib/html";

describe("htmlToPlainText", () => {
  it("strips simple tags", () => {
    expect(htmlToPlainText("<p>Hello world</p>")).toBe("Hello world");
  });

  it("strips nested and self-closing tags", () => {
    expect(htmlToPlainText("<div><p>Hello <br/> world</p></div>")).toBe("Hello world");
  });

  it("decodes named HTML entities", () => {
    expect(htmlToPlainText("Tom &amp; Jerry &lt;3 &quot;friends&quot;")).toBe('Tom & Jerry <3 "friends"');
  });

  it("decodes numeric decimal entities", () => {
    expect(htmlToPlainText("caf&#233;")).toBe("café");
  });

  it("decodes numeric hex entities", () => {
    expect(htmlToPlainText("caf&#xe9;")).toBe("café");
  });

  it("decodes &nbsp; to a plain space, then collapses it", () => {
    expect(htmlToPlainText("a&nbsp;&nbsp;b")).toBe("a b");
  });

  it("collapses internal whitespace (including newlines/tabs) to single spaces", () => {
    expect(htmlToPlainText("line one\n\n  line   two\t\tline three")).toBe("line one line two line three");
  });

  it("trims leading/trailing whitespace", () => {
    expect(htmlToPlainText("   padded text   ")).toBe("padded text");
  });

  it("returns an empty string for null/undefined/empty input", () => {
    expect(htmlToPlainText(null)).toBe("");
    expect(htmlToPlainText(undefined)).toBe("");
    expect(htmlToPlainText("")).toBe("");
  });

  it("does not choke on malformed/unclosed markup", () => {
    expect(htmlToPlainText("<p>unclosed paragraph <b>bold text")).toBe("unclosed paragraph bold text");
  });

  it("leaves an unrecognized entity-like sequence untouched rather than guessing", () => {
    expect(htmlToPlainText("5 &lt; 10 &notarealentity; end")).toBe("5 < 10 &notarealentity; end");
  });

  it("handles a realistic RSS content:encoded fragment", () => {
    const html = "<p>OpenAI today announced <strong>GPT-Next</strong>.</p>\n<p>It supports &amp; extends prior models.</p>";
    // Tag removal inserts a space regardless of adjacency to punctuation
    // (a space before ".") — this documents that real, existing behavior
    // rather than asserting a hand-polished result this function never
    // promised (it strips tags for display, not for typography).
    expect(htmlToPlainText(html)).toBe("OpenAI today announced GPT-Next . It supports & extends prior models.");
  });
});
