import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkThresholds, percentile, scoreCase, summarize, type CaseRun, type GoldenCase } from "./scorers";

const golden: GoldenCase = {
  id: "t1",
  tags: ["ranked-list"],
  companyName: "Notion",
  competitors: ["Asana", "Trello"],
  response: "",
  expected: { mentionedBrands: ["Notion", "Asana", "Monday"], ranking: 2, sentiment: "Positive" },
};

function run(prediction: CaseRun["prediction"], overrides: Partial<CaseRun> = {}): CaseRun {
  return {
    caseId: "t1",
    tags: ["ranked-list"],
    prediction,
    schemaIssues: [],
    latencyMs: 100,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    ...overrides,
  };
}

const perfect = {
  mentionedBrands: ["Notion", "Asana", "Monday"],
  mentionedProducts: [],
  citations: [],
  ranking: 2,
  reasoning: "",
  sentiment: "Positive" as const,
};

describe("scoreCase", () => {
  it("scores a perfect prediction as fully correct", () => {
    const s = scoreCase(golden, run(perfect));
    assert.deepEqual(s.failures, []);
    assert.equal(s.trackedTp, 2);
    assert.equal(s.trackedFp, 0);
    assert.equal(s.trackedFn, 0);
    assert.equal(s.allBrandsHit, 3);
  });

  it("counts tracked false positives/negatives and ranking error", () => {
    const s = scoreCase(
      golden,
      run({ ...perfect, mentionedBrands: ["notion", "Trello"], ranking: 4, sentiment: "Neutral" })
    );
    assert.equal(s.mentionCorrect, true, "brand matching is case-insensitive");
    assert.equal(s.trackedFp, 1);
    assert.equal(s.trackedFn, 1);
    assert.equal(s.rankingAbsError, 2);
    assert.equal(s.sentimentCorrect, false);
    assert.equal(s.recommendedCorrect, false, "rank 4 + neutral is not a recommendation");
  });

  it("treats an unparseable run as wrong on every metric", () => {
    const s = scoreCase(golden, run(null, { error: "boom" }));
    assert.equal(s.parsed, false);
    assert.equal(s.trackedFn, 2);
    assert.match(s.failures[0], /boom/);
  });
});

describe("summarize", () => {
  it("aggregates rates, F1 and the confusion matrix", () => {
    const runs = [run(perfect), run({ ...perfect, sentiment: "Negative" }), run(null)];
    const scores = runs.map((r) => scoreCase(golden, r));
    const s = summarize(scores, runs);
    assert.equal(s.cases, 3);
    assert.equal(s.parseRate, 2 / 3);
    assert.equal(s.sentimentAccuracy, 1 / 3);
    assert.equal(s.sentimentConfusion.Positive.Positive, 1);
    assert.equal(s.sentimentConfusion.Positive.Negative, 1);
    assert.equal(s.sentimentConfusion.Positive.Unparsed, 1);
    assert.equal(s.trackedBrandPrecision, 1);
    assert.equal(s.trackedBrandRecall, 4 / 6);
  });
});

describe("helpers", () => {
  it("percentile uses nearest-rank", () => {
    assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
    assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
    assert.equal(percentile([], 50), 0);
  });

  it("checkThresholds reports only metrics below their minimum", () => {
    const scores = [scoreCase(golden, run(perfect))];
    const summary = summarize(scores, [run(perfect)]);
    assert.deepEqual(checkThresholds(summary, { mentionAccuracy: 1, rankingExact: 1 }), []);
    const bad = summarize([scoreCase(golden, run(null))], [run(null)]);
    assert.equal(checkThresholds(bad, { parseRate: 1 }).length, 1);
  });
});
