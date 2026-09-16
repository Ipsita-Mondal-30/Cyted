# Scoring and Ranking Logic

## What Gets Measured

The system produces five primary metrics and one composite score. All are computed in `src/lib/services/metrics.service.ts` from the `ExtractedResult` rows.

The inputs are structured extractions from every LLM response:
```
{
  mentionedBrands: string[],   // all brands named in the response
  ranking: number | null,      // 1-based position in ranked list
  sentiment: string | null,    // "Positive" | "Neutral" | "Negative"
  citations: string[],         // URLs cited
}
```

---

## The Five Primary Metrics

### 1. Mention Rate

> Of all unique search queries, what fraction had the target company mentioned by at least one provider?

```typescript
// Group extractions by promptId
const promptsWithMention = new Set<string>();
const allPromptIds = new Set<string>();

for (const extraction of extractions) {
  allPromptIds.add(extraction.response.promptId);
  if (extraction.mentionedBrands.includes(companyName)) {
    promptsWithMention.add(extraction.response.promptId);
  }
}

mentionRate = (promptsWithMention.size / allPromptIds.size) * 100;
```

**Why "at least one provider"**: The bar is whether the company surfaces anywhere in the AI ecosystem for a given query type, not whether all providers agree. A brand that only appears on OpenAI but not Gemini still "gets mentioned" on that query — it has partial visibility.

Range: 0–100%. A 100% mention rate means the brand appeared in at least one provider's response for every query category tested.

---

### 2. Share of Voice

> Of all brand mentions across all responses and all providers, what fraction were mentions of the target company?

```typescript
const allMentions: Record<string, number> = {};

for (const extraction of extractions) {
  for (const brand of extraction.mentionedBrands) {
    const normalized = normalizeBrand(brand); // case-insensitive match
    allMentions[normalized] = (allMentions[normalized] ?? 0) + 1;
  }
}

const totalMentions = Object.values(allMentions).reduce((a, b) => a + b, 0);
shareOfVoice = ((allMentions[companyName] ?? 0) / totalMentions) * 100;
```

**Why this matters**: A company can have a 100% mention rate (mentioned on every query) but a 10% share of voice (every response also mentions 9 competitors). Share of voice tells you how dominant the brand is relative to its competitive set.

Range: 0–100%. Higher is better. `competitorShare` stores the per-brand breakdown:
```json
{
  "Acme Corp": 0.42,
  "Rival Inc": 0.31,
  "OtherCo": 0.15,
  "Salesforce": 0.12
}
```

---

### 3. Citation Rate

> Of all responses that mentioned the target company, what fraction included at least one URL citation?

```typescript
const companyMentions = extractions.filter(e =>
  e.mentionedBrands.includes(companyName)
);

const mentionsWithCitations = companyMentions.filter(e =>
  e.citations && e.citations.length > 0
);

citationRate = (mentionsWithCitations.length / companyMentions.length) * 100;
```

**Why this matters**: Citations are a proxy for how trustworthy and authoritative the AI considers the brand's web presence. AI providers (especially Gemini with Google grounding and Claude with web search) cite sources when they have high confidence in a specific source. A high citation rate suggests the brand has strong, crawlable, authoritative web content.

Range: 0–100%.

---

### 4. Recommendation Rate

> Of all AI responses analyzed, what fraction gave the target company a "recommended" signal — defined as being mentioned **and** (getting positive sentiment OR being ranked in the top 3)?

```typescript
const recommendedExtractions = extractions.filter(e =>
  e.mentionedBrands.includes(companyName) &&
  (e.sentiment === "Positive" || (e.ranking !== null && e.ranking <= 3))
);

recommendationRate = (recommendedExtractions.length / extractions.length) * 100;
```

The `|| ranking <= 3` condition captures responses where the brand is listed without explicit sentiment (e.g. "Top 5 CRM tools: 1. Acme, 2. Rival...") but positioned favorably.

Range: 0–100%. This is the metric most directly tied to "will an AI recommend this brand to a buyer?"

---

### 5. Average Ranking

> Across all responses where the target company appeared in a ranked list, what was the mean rank position?

```typescript
const rankings = extractions
  .filter(e =>
    e.ranking !== null &&
    e.mentionedBrands.includes(companyName)
  )
  .map(e => e.ranking as number);

avgRanking = rankings.length > 0
  ? rankings.reduce((a, b) => a + b, 0) / rankings.length
  : null;
```

Range: 1.0 (always ranked #1) to N (ranked last). `null` if the brand was never in a ranked list. Lower is better.

This metric has a `null` case that the UI handles gracefully — if no rankings exist, the metric card shows "N/A" rather than 0.

---

## The Composite: Visibility Score

The visibility score is a **weighted sum** of the primary metrics, normalized to 0–100:

```typescript
// Convert avgRanking to a 0-100 score (lower rank = higher score)
// Assumes max meaningful rank depth of 10
const rankingScore = avgRanking !== null
  ? Math.max(0, (10 - avgRanking) / 9 * 100)
  : 0;

visibilityScore =
  mentionRate        * 0.35 +   // 35% weight
  shareOfVoice       * 0.25 +   // 25% weight
  recommendationRate * 0.25 +   // 25% weight
  citationRate       * 0.10 +   // 10% weight
  rankingScore       * 0.05;    // 5%  weight
```

### Why These Weights?

| Metric | Weight | Rationale |
|---|---|---|
| Mention Rate | 35% | Most fundamental signal — are you in the conversation at all? |
| Share of Voice | 25% | How dominant are you vs. competitors? |
| Recommendation Rate | 25% | Are you being actively recommended, not just mentioned? |
| Citation Rate | 10% | Secondary signal — better content, not always controllable |
| Ranking Score | 5% | Useful but sparse — many responses don't include ranked lists |

The weights are hardcoded in `metrics.service.ts`. They reflect a design judgment about what matters most for AEO. They are not user-configurable.

---

## How Companies Are Benchmarked Against Competitors

The competitor share chart shows each brand's share of voice as a fraction of total mentions. This is extracted from `Metrics.competitorShare`:

```json
{
  "Acme Corp": 0.42,
  "Rival Inc": 0.31,
  "OtherCo": 0.15,
  "Salesforce": 0.12
}
```

These fractions sum to 1.0 (roughly — floating point). They're used to render a bar chart in `ReportRankingHero`:

```
Acme Corp   ████████████████████████ 42%   ← target company (highlighted)
Rival Inc   █████████████████        31%
OtherCo     █████████                15%
Salesforce  ███████                  12%
```

The "ranking" in the hero isn't a separate computed field — it's simply the brands sorted by share of voice, descending. Position 1 is the brand with the highest share of voice.

---

## The Positive Sentiment Rate Quirk

Positive sentiment rate doesn't have its own column in the `Metrics` table (there was no schema migration to add it). Instead it's stored inside `competitorShare` with a reserved key:

```typescript
// metrics.service.ts
const competitorShareWithSentiment = {
  ...competitorShare,
  __positiveSentimentRate: positiveSentimentRate,
};

await prisma.metrics.upsert({
  data: { competitorShare: competitorShareWithSentiment, ... }
});
```

And extracted on read in `report-serialize.ts`:
```typescript
const positiveSentimentRate =
  (competitorShare as Record<string, number>).__positiveSentimentRate ?? null;

// Clean it out before exposing competitorShare to the UI
const cleanedCompetitorShare = Object.fromEntries(
  Object.entries(competitorShare as Record<string, number>)
    .filter(([key]) => key !== "__positiveSentimentRate")
);
```

This is explicitly noted in comments as a workaround to avoid a schema migration. The correct fix is a dedicated column.

---

## Metric Tone Classification

The UI uses `scoreTone()` to classify each metric as Poor / Fair / Good:

```typescript
// InsightMetricCard.tsx
export function scoreTone(value: number, thresholds: { low: number; high: number }): MetricTone {
  if (value >= thresholds.high) return "Good";
  if (value >= thresholds.low)  return "Fair";
  return "Poor";
}
```

Thresholds per metric (from the UI component usage):

| Metric | Poor | Fair | Good |
|---|---|---|---|
| Visibility Score | < 40 | 40–65 | ≥ 65 |
| Positive Sentiment | < 40 | 40–65 | ≥ 65 |
| Citation Rate | < 30 | 30–55 | ≥ 55 |
| Recommendation Rate | < 30 | 30–55 | ≥ 55 |

These thresholds are hardcoded in the component and reflect what the team considers meaningful for AEO performance. They're not derived from historical data benchmarks.
