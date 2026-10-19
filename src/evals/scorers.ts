import { brandMatches, isRecommendedMention } from "@/lib/report-analytics";
import type { ExtractionPayload, Sentiment } from "@/lib/services/extraction-prompt";

export type GoldenCase = {
  id: string;
  tags: string[];
  companyName: string;
  competitors: string[];
  response: string;
  expected: {
    mentionedBrands: string[];
    ranking: number | null;
    sentiment: Sentiment;
  };
  notes?: string;
};

export type GoldenDataset = {
  name: string;
  version: number;
  description?: string;
  cases: GoldenCase[];
};

/** One extractor run on one golden case. `prediction` is null when the output could not be parsed. */
export type CaseRun = {
  caseId: string;
  tags: string[];
  prediction: ExtractionPayload | null;
  schemaIssues: string[];
  error?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type CaseScore = {
  caseId: string;
  tags: string[];
  parsed: boolean;
  schemaValid: boolean;
  mentionCorrect: boolean;
  trackedTp: number;
  trackedFp: number;
  trackedFn: number;
  allBrandsHit: number;
  allBrandsTotal: number;
  rankingExact: boolean;
  /** |predicted − expected| when both are ranked, else null */
  rankingAbsError: number | null;
  sentimentCorrect: boolean;
  recommendedCorrect: boolean;
  expectedSentiment: Sentiment;
  predictedSentiment: Sentiment | null;
  failures: string[];
};

export const SENTIMENTS: Sentiment[] = ["Positive", "Neutral", "Negative"];

/**
 * Score one prediction against its label. Brand precision/recall is computed
 * over the *tracked* set (company + competitors) because that is all the
 * downstream visibility metrics consume; recall over every brand in the
 * label is reported separately as a secondary signal.
 */
export function scoreCase(golden: GoldenCase, run: CaseRun): CaseScore {
  const p = run.prediction;
  const tracked = [golden.companyName, ...golden.competitors];
  const expectedHit = brandMatches(golden.companyName, golden.expected.mentionedBrands);
  const failures: string[] = [];

  if (!p) {
    const trackedExpected = tracked.filter((b) =>
      brandMatches(b, golden.expected.mentionedBrands)
    ).length;
    return {
      caseId: golden.id,
      tags: golden.tags,
      parsed: false,
      schemaValid: false,
      mentionCorrect: false,
      trackedTp: 0,
      trackedFp: 0,
      trackedFn: trackedExpected,
      allBrandsHit: 0,
      allBrandsTotal: golden.expected.mentionedBrands.length,
      rankingExact: false,
      rankingAbsError: null,
      sentimentCorrect: false,
      recommendedCorrect: false,
      expectedSentiment: golden.expected.sentiment,
      predictedSentiment: null,
      failures: [`unparseable output: ${run.error ?? "unknown error"}`],
    };
  }

  const predictedHit = brandMatches(golden.companyName, p.mentionedBrands);
  if (predictedHit !== expectedHit) {
    failures.push(`company mention: expected ${expectedHit}, got ${predictedHit}`);
  }

  let trackedTp = 0;
  let trackedFp = 0;
  let trackedFn = 0;
  for (const brand of tracked) {
    const want = brandMatches(brand, golden.expected.mentionedBrands);
    const got = brandMatches(brand, p.mentionedBrands);
    if (want && got) trackedTp += 1;
    else if (got) {
      trackedFp += 1;
      failures.push(`false positive brand: ${brand}`);
    } else if (want) {
      trackedFn += 1;
      failures.push(`missed brand: ${brand}`);
    }
  }

  const allBrandsHit = golden.expected.mentionedBrands.filter((b) =>
    brandMatches(b, p.mentionedBrands)
  ).length;

  const rankingExact = p.ranking === golden.expected.ranking;
  if (!rankingExact) {
    failures.push(`ranking: expected ${golden.expected.ranking}, got ${p.ranking}`);
  }
  const rankingAbsError =
    p.ranking != null && golden.expected.ranking != null
      ? Math.abs(p.ranking - golden.expected.ranking)
      : null;

  const sentimentCorrect = p.sentiment === golden.expected.sentiment;
  if (!sentimentCorrect) {
    failures.push(`sentiment: expected ${golden.expected.sentiment}, got ${p.sentiment}`);
  }

  const recommendedCorrect =
    isRecommendedMention(predictedHit, p.sentiment, p.ranking) ===
    isRecommendedMention(expectedHit, golden.expected.sentiment, golden.expected.ranking);

  return {
    caseId: golden.id,
    tags: golden.tags,
    parsed: true,
    schemaValid: run.schemaIssues.length === 0,
    mentionCorrect: predictedHit === expectedHit,
    trackedTp,
    trackedFp,
    trackedFn,
    allBrandsHit,
    allBrandsTotal: golden.expected.mentionedBrands.length,
    rankingExact,
    rankingAbsError,
    sentimentCorrect,
    recommendedCorrect,
    expectedSentiment: golden.expected.sentiment,
    predictedSentiment: p.sentiment,
    failures,
  };
}

export type EvalSummary = {
  cases: number;
  parseRate: number;
  schemaValidity: number;
  mentionAccuracy: number;
  trackedBrandPrecision: number;
  trackedBrandRecall: number;
  trackedBrandF1: number;
  allBrandRecall: number;
  rankingExact: number;
  rankingMae: number | null;
  sentimentAccuracy: number;
  recommendedAccuracy: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  totalCostUsd: number;
  /** confusion[expected][predicted]; "Unparsed" column for failed parses */
  sentimentConfusion: Record<Sentiment, Record<Sentiment | "Unparsed", number>>;
};

function ratio(n: number, d: number) {
  return d > 0 ? n / d : 0;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarize(scores: CaseScore[], runs: CaseRun[]): EvalSummary {
  const n = scores.length;
  const count = (f: (s: CaseScore) => boolean) => scores.filter(f).length;
  const tp = scores.reduce((a, s) => a + s.trackedTp, 0);
  const fp = scores.reduce((a, s) => a + s.trackedFp, 0);
  const fn = scores.reduce((a, s) => a + s.trackedFn, 0);
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const absErrors = scores
    .map((s) => s.rankingAbsError)
    .filter((e): e is number => e != null);

  const sentimentConfusion = Object.fromEntries(
    SENTIMENTS.map((e) => [
      e,
      Object.fromEntries([...SENTIMENTS, "Unparsed"].map((p) => [p, 0])),
    ])
  ) as EvalSummary["sentimentConfusion"];
  for (const s of scores) {
    sentimentConfusion[s.expectedSentiment][s.predictedSentiment ?? "Unparsed"] += 1;
  }

  return {
    cases: n,
    parseRate: ratio(count((s) => s.parsed), n),
    schemaValidity: ratio(count((s) => s.schemaValid), n),
    mentionAccuracy: ratio(count((s) => s.mentionCorrect), n),
    trackedBrandPrecision: precision,
    trackedBrandRecall: recall,
    trackedBrandF1: precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0,
    allBrandRecall: ratio(
      scores.reduce((a, s) => a + s.allBrandsHit, 0),
      scores.reduce((a, s) => a + s.allBrandsTotal, 0)
    ),
    rankingExact: ratio(count((s) => s.rankingExact), n),
    rankingMae: absErrors.length
      ? absErrors.reduce((a, b) => a + b, 0) / absErrors.length
      : null,
    sentimentAccuracy: ratio(count((s) => s.sentimentCorrect), n),
    recommendedAccuracy: ratio(count((s) => s.recommendedCorrect), n),
    latencyP50Ms: percentile(runs.map((r) => r.latencyMs), 50),
    latencyP95Ms: percentile(runs.map((r) => r.latencyMs), 95),
    totalCostUsd: runs.reduce((a, r) => a + r.costUsd, 0),
    sentimentConfusion,
  };
}

/** Metrics that can be gated, all "higher is better" and in [0, 1]. */
export const GATED_METRICS = [
  "parseRate",
  "schemaValidity",
  "mentionAccuracy",
  "trackedBrandF1",
  "rankingExact",
  "sentimentAccuracy",
  "recommendedAccuracy",
] as const;

export type GatedMetric = (typeof GATED_METRICS)[number];
export type Thresholds = Partial<Record<GatedMetric, number>>;

export function checkThresholds(summary: EvalSummary, thresholds: Thresholds): string[] {
  return GATED_METRICS.flatMap((metric) => {
    const min = thresholds[metric];
    if (min == null) return [];
    const actual = summary[metric];
    return actual + 1e-9 < min
      ? [`${metric} ${(actual * 100).toFixed(1)}% < required ${(min * 100).toFixed(1)}%`]
      : [];
  });
}
