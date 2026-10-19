import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  brandMatches,
  computeReportAnalytics,
  isRecommendedMention,
  rankingScore,
  VISIBILITY_WEIGHTS,
} from "./report-analytics";

describe("visibility scoring", () => {
  it("weights sum to 1 so the score stays within 0–100", () => {
    const total = Object.values(VISIBILITY_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
  });

  it("rankingScore is 1 at rank 1 and floors at 0", () => {
    assert.equal(rankingScore(1), 1);
    assert.equal(rankingScore(null), 0);
    assert.equal(rankingScore(50), 0);
  });

  it("recommended = mentioned and (positive or top-3)", () => {
    assert.equal(isRecommendedMention(true, "Positive", null), true);
    assert.equal(isRecommendedMention(true, "Neutral", 3), true);
    assert.equal(isRecommendedMention(true, "Negative", 4), false);
    assert.equal(isRecommendedMention(false, "Positive", 1), false);
  });

  it("brandMatches is case-insensitive and tolerates suffixes", () => {
    assert.ok(brandMatches("HubSpot", ["Hubspot CRM"]));
    assert.ok(brandMatches("Zoho CRM", ["Zoho"]));
    assert.ok(!brandMatches("Notion", ["Asana"]));
  });
});

describe("computeReportAnalytics", () => {
  const ok = (provider: string, brands: string[], ranking: number | null, sentiment: string) => ({
    provider,
    error: null,
    extracted: { mentionedBrands: brands, ranking, sentiment },
  });

  it("aggregates per provider, category, sentiment and rank buckets", () => {
    const a = computeReportAnalytics(
      [
        {
          category: "comparison",
          responses: [
            ok("gemini", ["Notion", "Asana"], 1, "Positive"),
            ok("openai", ["Asana"], null, "Neutral"),
            { provider: "groq", error: "rate limited", extracted: null },
          ],
        },
        {
          category: "pricing",
          responses: [ok("gemini", ["Notion"], 5, "Negative")],
        },
      ],
      "Notion",
      ["Notion", "Asana"]
    );

    const gemini = a.providers.find((p) => p.provider === "gemini")!;
    assert.equal(gemini.responses, 2);
    assert.equal(gemini.mentionRate, 100);
    assert.equal(gemini.positiveRate, 50);
    assert.equal(gemini.avgRank, 3);
    assert.equal(a.providers.find((p) => p.provider === "groq")!.failed, 1);

    assert.deepEqual(a.sentiment, { positive: 1, neutral: 0, negative: 1, notMentioned: 1 });
    assert.equal(a.rankBuckets.find((b) => b.label === "#1")!.count, 1);
    assert.equal(a.rankBuckets.find((b) => b.label === "#4–5")!.count, 1);
    assert.equal(a.categories.find((c) => c.category === "comparison")!.mentionRate, 50);
    assert.equal(a.heatmap.find((h) => h.brand === "Asana")!.rates.openai, 100);
  });
});
