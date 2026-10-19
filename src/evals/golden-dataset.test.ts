import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { brandMatches } from "@/lib/report-analytics";
import { SENTIMENTS, type GoldenDataset } from "./scorers";

const dataset = JSON.parse(
  readFileSync("evals/datasets/extraction.golden.json", "utf8")
) as GoldenDataset;

describe("golden dataset integrity", () => {
  it("has unique case ids", () => {
    const ids = dataset.cases.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  for (const c of dataset.cases) {
    it(`${c.id} is internally consistent`, () => {
      assert.ok(c.response.trim(), "response is non-empty");
      assert.ok(c.tags.length, "has at least one tag");
      assert.ok(SENTIMENTS.includes(c.expected.sentiment), "sentiment is a known label");
      const mentioned = brandMatches(c.companyName, c.expected.mentionedBrands);
      if (c.expected.ranking != null) {
        assert.ok(mentioned, "a ranked company must be in mentionedBrands");
        assert.ok(c.expected.ranking >= 1);
      }
      if (!mentioned) {
        assert.equal(c.expected.sentiment, "Neutral", "unmentioned company is labelled Neutral");
      }
    });
  }
});
