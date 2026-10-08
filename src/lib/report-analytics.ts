/**
 * Client-safe analytics derived from a serialized report. Kept free of server
 * imports so both the metrics service and dashboard charts can share it.
 */

/** Weights (summing to 1) used to blend the visibility score. */
export const VISIBILITY_WEIGHTS = {
  mentionRate: 0.35,
  shareOfVoice: 0.25,
  recommendationRate: 0.25,
  citationRate: 0.1,
  ranking: 0.05,
} as const;

export function rankingScore(avgRanking: number | null): number {
  return avgRanking == null ? 0 : Math.max(0, 1 - (avgRanking - 1) / 10);
}

export function brandMatches(name: string, brands: string[]): boolean {
  const target = name.toLowerCase().trim();
  if (!target) return false;
  return brands.some((b) => {
    const brand = b.toLowerCase().trim();
    return brand === target || brand.includes(target) || target.includes(brand);
  });
}

type AnalyticsResponse = {
  provider: string;
  error: string | null;
  extracted: {
    mentionedBrands: unknown;
    ranking: number | null;
    sentiment: string | null;
  } | null;
};

type AnalyticsPrompt = {
  category: string;
  responses: AnalyticsResponse[];
};

export type ProviderStat = {
  provider: string;
  responses: number;
  failed: number;
  mentions: number;
  /** % of answered responses that mention the brand. */
  mentionRate: number;
  /** % of brand mentions with positive sentiment; null when never mentioned. */
  positiveRate: number | null;
  avgRank: number | null;
};

export type CategoryStat = {
  category: string;
  responses: number;
  mentions: number;
  mentionRate: number;
};

export type SentimentSplit = {
  positive: number;
  neutral: number;
  negative: number;
  notMentioned: number;
};

export type RankBucket = { label: string; count: number };

export type HeatmapRow = {
  brand: string;
  isYou: boolean;
  /** provider -> % of that provider's answered responses mentioning the brand */
  rates: Record<string, number>;
};

export type ReportAnalytics = {
  providers: ProviderStat[];
  categories: CategoryStat[];
  sentiment: SentimentSplit;
  rankBuckets: RankBucket[];
  heatmap: HeatmapRow[];
};

const RANK_BUCKETS: Array<{ label: string; test: (rank: number) => boolean }> = [
  { label: "#1", test: (r) => r === 1 },
  { label: "#2", test: (r) => r === 2 },
  { label: "#3", test: (r) => r === 3 },
  { label: "#4–5", test: (r) => r >= 4 && r <= 5 },
  { label: "#6+", test: (r) => r >= 6 },
];

function pct(part: number, whole: number) {
  return whole > 0 ? (part / whole) * 100 : 0;
}

export function computeReportAnalytics(
  prompts: AnalyticsPrompt[],
  companyName: string,
  heatmapBrands: string[]
): ReportAnalytics {
  type ProviderAcc = {
    responses: number;
    failed: number;
    mentions: number;
    positive: number;
    ranks: number[];
    brandHits: Record<string, number>;
  };
  const byProvider = new Map<string, ProviderAcc>();
  const byCategory = new Map<string, { responses: number; mentions: number }>();
  const sentiment: SentimentSplit = {
    positive: 0,
    neutral: 0,
    negative: 0,
    notMentioned: 0,
  };
  const ranks: number[] = [];

  for (const prompt of prompts) {
    for (const r of prompt.responses) {
      let p = byProvider.get(r.provider);
      if (!p) {
        p = {
          responses: 0,
          failed: 0,
          mentions: 0,
          positive: 0,
          ranks: [],
          brandHits: {},
        };
        byProvider.set(r.provider, p);
      }

      if (r.error || !r.extracted) {
        p.failed += 1;
        continue;
      }

      const brands = Array.isArray(r.extracted.mentionedBrands)
        ? (r.extracted.mentionedBrands as string[])
        : [];
      const hit = brandMatches(companyName, brands);
      const tone = (r.extracted.sentiment || "").toLowerCase();
      const rank = r.extracted.ranking;

      p.responses += 1;
      for (const b of heatmapBrands) {
        if (brandMatches(b, brands)) p.brandHits[b] = (p.brandHits[b] || 0) + 1;
      }

      const cat = byCategory.get(prompt.category) || { responses: 0, mentions: 0 };
      cat.responses += 1;

      if (rank != null && rank > 0) {
        ranks.push(rank);
        p.ranks.push(rank);
      }

      if (hit) {
        p.mentions += 1;
        cat.mentions += 1;
        if (tone === "positive") {
          p.positive += 1;
          sentiment.positive += 1;
        } else if (tone === "negative") {
          sentiment.negative += 1;
        } else {
          sentiment.neutral += 1;
        }
      } else {
        sentiment.notMentioned += 1;
      }
      byCategory.set(prompt.category, cat);
    }
  }

  const providers: ProviderStat[] = [...byProvider.entries()].map(
    ([provider, p]) => ({
      provider,
      responses: p.responses,
      failed: p.failed,
      mentions: p.mentions,
      mentionRate: pct(p.mentions, p.responses),
      positiveRate: p.mentions > 0 ? pct(p.positive, p.mentions) : null,
      avgRank:
        p.ranks.length > 0
          ? p.ranks.reduce((a, b) => a + b, 0) / p.ranks.length
          : null,
    })
  );

  const categories: CategoryStat[] = [...byCategory.entries()]
    .map(([category, c]) => ({
      category,
      responses: c.responses,
      mentions: c.mentions,
      mentionRate: pct(c.mentions, c.responses),
    }))
    .sort((a, b) => b.mentionRate - a.mentionRate);

  const rankBuckets = RANK_BUCKETS.map((b) => ({
    label: b.label,
    count: ranks.filter(b.test).length,
  }));

  const heatmap: HeatmapRow[] = heatmapBrands.map((brand) => ({
    brand,
    isYou: brand === companyName,
    rates: Object.fromEntries(
      [...byProvider.entries()].map(([provider, p]) => [
        provider,
        pct(p.brandHits[brand] || 0, p.responses),
      ])
    ),
  }));

  return { providers, categories, sentiment, rankBuckets, heatmap };
}
