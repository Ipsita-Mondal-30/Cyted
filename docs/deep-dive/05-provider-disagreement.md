# What Happens When Providers Disagree

## The Core Reality: Disagreement Is Expected

LLM providers have fundamentally different training data, search indexes, ranking algorithms, and response styles. On a query like "best CRM for small teams," you should *expect* disagreement:

- OpenAI might rank Salesforce #1 because its training data skews enterprise
- Gemini (with Google Search grounding) might surface a recent review article ranking HubSpot first
- Claude might answer conversationally without ranking at all
- Groq's compound model might pull from a different web index entirely

This isn't a bug — it's the entire point. The system measures how consistently a brand surfaces *across* providers, not whether providers agree with each other.

---

## How Disagreement is Stored

Each provider response is stored independently:

```
Prompt: "What is the best CRM for small teams?"

Response table after extraction:
┌──────────────────────────────────────────────────────────────────────────────┐
│ provider  │ mentionedBrands              │ ranking │ sentiment │ response_id │
├──────────────────────────────────────────────────────────────────────────────┤
│ openai    │ ["Acme", "Salesforce"]       │    2    │ Positive  │ resp_001    │
│ gemini    │ ["HubSpot", "Salesforce"]    │  null   │ Neutral   │ resp_002    │
│ claude    │ ["Acme", "HubSpot", "Rival"] │    1    │ Positive  │ resp_003    │
│ groq      │ ["Salesforce"]               │  null   │ Neutral   │ resp_004    │
└──────────────────────────────────────────────────────────────────────────────┘
```

For this single prompt:
- Acme was mentioned by 2/4 providers (OpenAI and Claude)
- Gemini and Groq did not mention Acme at all
- Claude ranked Acme #1; OpenAI ranked it #2; the others gave no ranking
- Sentiment was Positive from two providers, Neutral from two

There is no reconciliation step. Both data points are preserved exactly as extracted.

---

## How Metrics Handle the Disagreement

The metrics are aggregate statistics across all extractions. Disagreement is "resolved" through averaging:

### Mention Rate

```typescript
// How many unique prompts had Acme mentioned by at least one provider?
const promptsWithMention = new Set(
  extractions
    .filter(e => e.mentionedBrands.includes(companyName))
    .map(e => e.response.promptId)
);

mentionRate = promptsWithMention.size / totalPrompts * 100;
```

For the example above: Acme was mentioned by at least one provider for this prompt, so this prompt counts as a "mention." Even though 2 out of 4 providers missed it.

This is intentional. The question being answered is: "**Does an AI assistant mention this brand when asked about this topic?**" — not "**Does every AI assistant mention it?**" If any one of the major AI assistants surfaces the brand, that's a visibility signal.

### Share of Voice

```typescript
// Total brand mention counts across all extractions
const brandCounts: Record<string, number> = {};
for (const extraction of extractions) {
  for (const brand of extraction.mentionedBrands) {
    brandCounts[brand] = (brandCounts[brand] ?? 0) + 1;
  }
}

const totalMentions = Object.values(brandCounts).reduce((a, b) => a + b, 0);
shareOfVoice = (brandCounts[companyName] ?? 0) / totalMentions * 100;
```

In the example: Acme mentioned 2 times, Salesforce 3 times, HubSpot 2 times, Rival 1 time. Total: 8.
Acme's share of voice = 2/8 = 25%.

### Sentiment and Ranking

Both use all non-null values across all extractions:

```typescript
// Positive sentiment rate
const positiveCount = extractions.filter(
  e => e.mentionedBrands.includes(companyName) && e.sentiment === "Positive"
).length;
positiveSentimentRate = positiveCount / acmeMentionCount * 100;

// Average ranking (only extractions where company was ranked)
const rankings = extractions
  .filter(e => e.ranking !== null && e.mentionedBrands.includes(companyName))
  .map(e => e.ranking!);
avgRanking = rankings.reduce((a, b) => a + b, 0) / rankings.length;
```

---

## What Disagreement Means for Interpretation

A high **mention rate** with a low **share of voice** means: the brand gets mentioned across many queries, but it's always buried alongside many competitors. It's present but not dominant.

A low **mention rate** with a high **positive sentiment rate** (when mentioned) means: the brand rarely surfaces, but when it does, it's described favorably.

Disagreement between providers on ranking is especially meaningful:
- **Consistent high ranking** (e.g. ranked #1 by OpenAI, #1 by Gemini, #1 by Claude) = strong signal. The brand dominates across AI indexes.
- **Split ranking** (e.g. #1 by OpenAI, not ranked by Gemini, #3 by Claude) = inconsistent visibility. Different AI consumers get different answers.
- **No ranking from any provider** = the brand is mentioned but not recommended as a top choice.

The UI surfaces this ambiguity by showing the raw responses in the expandable prompt rows (private mode). Users can see exactly what each provider said about their brand.

---

## A Concrete Disagreement Scenario

Company: **Acme Corp** (real example pattern)

Prompt: "Is Acme Corp a good choice for enterprise sales teams?"

```
OpenAI response:
  "Acme Corp is widely regarded as an excellent choice for enterprise sales teams.
   Its pipeline management features are best-in-class..."
  → Extracted: { mentionedBrands: ["Acme Corp"], ranking: 1, sentiment: "Positive" }

Gemini response (with Google Search grounding):
  "Recent reviews of Acme Corp are mixed. While the product has strong features,
   there have been complaints about customer support. Many users prefer Rival Inc."
  → Extracted: { mentionedBrands: ["Acme Corp", "Rival Inc"], ranking: null, sentiment: "Negative" }

Claude response:
  "Acme Corp can be a good fit depending on your team size. For large enterprise teams
   (500+), you might also consider Salesforce or Rival Inc."
  → Extracted: { mentionedBrands: ["Acme Corp", "Rival Inc", "Salesforce"], ranking: null, sentiment: "Neutral" }

Groq response:
  "For enterprise sales, the top options are Salesforce, Microsoft Dynamics, and Rival Inc."
  → Extracted: { mentionedBrands: ["Salesforce", "Microsoft Dynamics", "Rival Inc"], ranking: null, sentiment: null }
  // Acme not mentioned at all
```

Resulting signals:
- Mention rate for this prompt: 75% (3/4 providers mentioned Acme)
- Sentiment for this prompt: 1 positive, 1 negative, 1 neutral = mixed
- Groq completely missed Acme — this is a real visibility gap on Groq's index

This is exactly the kind of nuanced signal the platform is designed to surface. Acme's marketing team can see: "We're visible on OpenAI and Claude, Gemini shows negative recent reviews, Groq doesn't mention us at all." Those are three different action items.

---

## No Reconciliation by Design

There is no voting, consensus, or conflict resolution step. The decision to aggregate rather than reconcile is deliberate:

1. **Each provider represents a real user segment**. Some users use ChatGPT. Some use Gemini. Some use Perplexity (which uses Groq under the hood). A brand that only surfaces on one provider has a real visibility gap with the users of the others.

2. **Reconciliation would hide the story**. If OpenAI gives Positive and Gemini gives Negative, a "consensus" of Neutral doesn't tell you that there's negative sentiment on one of the major AI platforms.

3. **The raw data is preserved**. Users can drill into every individual response in the dashboard. If the aggregate metric looks confusing, the answer is always available in the source data.
