import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExtractionPrompt, parseExtraction } from "./extraction-prompt";

const valid = {
  mentionedBrands: ["Notion", "Asana"],
  mentionedProducts: [],
  citations: ["https://g2.com"],
  ranking: 2,
  reasoning: "Listed second.",
  sentiment: "Positive",
};

describe("parseExtraction", () => {
  it("accepts a schema-valid object with no issues", () => {
    const { payload, schemaIssues } = parseExtraction(JSON.stringify(valid));
    assert.deepEqual(schemaIssues, []);
    assert.equal(payload.ranking, 2);
    assert.equal(payload.sentiment, "Positive");
  });

  it("recovers JSON from a fenced block surrounded by prose", () => {
    const raw = `Sure! Here you go:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\nHope that helps.`;
    assert.deepEqual(parseExtraction(raw).payload.mentionedBrands, ["Notion", "Asana"]);
  });

  it("normalizes deviations but reports each one", () => {
    const { payload, schemaIssues } = parseExtraction(
      JSON.stringify({ mentionedBrands: ["Notion", 3], ranking: 0, sentiment: "positive" })
    );
    assert.deepEqual(payload.mentionedBrands, ["Notion"]);
    assert.equal(payload.ranking, null);
    assert.equal(payload.sentiment, "Positive");
    assert.deepEqual(payload.citations, []);
    assert.ok(schemaIssues.some((i) => i.startsWith("sentiment")));
    assert.ok(schemaIssues.some((i) => i.startsWith("ranking")));
    assert.ok(schemaIssues.some((i) => i.startsWith("citations")));
  });

  it("throws when no JSON object is present", () => {
    assert.throws(() => parseExtraction("I cannot help with that."), /No JSON object/);
  });
});

describe("buildExtractionPrompt", () => {
  it("embeds company, competitors and truncates very long responses", () => {
    const { user } = buildExtractionPrompt({
      companyName: "Notion",
      competitors: ["Asana", "Trello"],
      rawResponse: "x".repeat(20_000),
    });
    assert.match(user, /Company being analyzed: Notion/);
    assert.match(user, /Competitors: Asana, Trello/);
    assert.ok(!user.includes("x".repeat(12_001)));
  });

  it("says 'none' when there are no competitors", () => {
    const { user } = buildExtractionPrompt({ companyName: "A", competitors: [], rawResponse: "" });
    assert.match(user, /Competitors: none/);
  });
});
