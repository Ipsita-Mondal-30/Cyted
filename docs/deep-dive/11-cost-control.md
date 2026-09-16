# Keeping API Costs Under Control

## What Costs Money

Every LLM API call costs money. Here's where the costs come from in one analysis:

| Step | LLM calls | Provider | Notes |
|---|---|---|---|
| Brand resolution | 1 | Gemini (preferred) | ~500 input tokens, ~200 output |
| Company context | 1 | Gemini (preferred) | ~300 input, ~300 output |
| Prompt generation | 1 | Gemini (preferred) | ~400 input, ~600 output |
| Provider search | 48 | All 4 providers | ~200 input, ~800 output per call (with web results) |
| Extraction | 48 | Gemini (preferred) | ~1200 input, ~200 output per call |
| Recommendations | 1 | Gemini (preferred) | ~2000 input, ~1500 output |
| **Total** | **~100 calls** | | |

Dominant cost: search calls (48) and extraction calls (48). The structural steps (brand, context, prompts, recommendations) are 4 calls total — marginal.

---

## Current Cost Controls in the Codebase

### 1. Model Selection: Cheap by Default

The defaults are intentionally cost-optimized:

```
GEMINI_MODEL=gemini-2.0-flash       # $0.075/1M input, $0.30/1M output
GROQ_MODEL=groq/compound            # Groq is cheap; compound has built-in search
GROQ_COMPLETE_MODEL=llama-3.3-70b-versatile  # Very cheap for extraction
CLAUDE_MODEL=claude-sonnet-4-20250514  # Mid-tier (not Opus)
OPENAI_MODEL=gpt-4o                 # Higher cost, but web search quality
```

Gemini Flash and Groq are the cheapest options that produce acceptable quality. The system prefers them for all structural tasks.

If you switched `GEMINI_MODEL` to `gemini-1.5-pro` or `OPENAI_MODEL` to `gpt-4o` with no concurrency changes, the per-analysis cost would increase 5–10× without any quality improvement for the extraction and recommendation tasks.

### 2. Provider Admin Toggles

The `/admin` page lets operators disable expensive providers instantly:

```
PUT /api/admin/providers
{ "enabledProviders": { "claude": false, "openai": false } }
```

If Claude's bill spikes, turn it off in 30 seconds without deploying. The change takes effect for the next queued job.

This is the most direct cost lever available: fewer providers = fewer search calls per analysis. Disabling 2 of 4 providers cuts search call costs by 50%.

### 3. Concurrency Limits Prevent Bill Runaway

`PER_PROVIDER_CONCURRENCY=2` means the worker will never have more than 2 in-flight calls to any provider at once. Combined with `SEARCH_CONCURRENCY=4`, the total simultaneous calls are bounded.

This isn't primarily a cost control (calls still happen, just spread over more time) but it prevents the kind of "fire 48 calls in 1 second" spike that could exhaust a rate limit and generate retry-storm costs.

### 4. Prompt Truncation (Groq)

Groq's compound model has input limits. The provider hard-truncates prompts before sending:

```typescript
const safePrompt = prompt.slice(0, 4000);   // search
const safeInput  = input.slice(0, 24000);   // complete
```

This prevents accidentally sending 50,000 tokens when 4,000 is sufficient, which would generate unexpected costs and 413 errors.

### 5. `PROMPTS_PER_CATEGORY` Tuning

The single most impactful cost lever in the config:

```
PROMPTS_PER_CATEGORY=1  → 6 prompts × 4 providers = 24 search calls
PROMPTS_PER_CATEGORY=2  → 12 prompts × 4 providers = 48 search calls (default)
PROMPTS_PER_CATEGORY=3  → 18 prompts × 4 providers = 72 search calls
```

Reducing to 1 prompt per category halves the search cost while still covering all 6 buying journey stages. The statistical confidence decreases (fewer data points), but for most companies the results are directionally accurate.

---

## The Admin Cost Dashboard

`GET /api/admin/usage` provides cost visibility:

```typescript
// ai-pricing.ts — simplified example
const MODEL_PRICING: Record<string, { inputPerMToken: number; outputPerMToken: number }> = {
  "gpt-4o":                  { inputPerMToken: 2.50,   outputPerMToken: 10.00 },
  "gemini-2.0-flash":        { inputPerMToken: 0.075,  outputPerMToken: 0.30  },
  "claude-sonnet-4-20250514":{ inputPerMToken: 3.00,   outputPerMToken: 15.00 },
  "llama-3.3-70b-versatile": { inputPerMToken: 0.59,   outputPerMToken: 0.79  },
};

function estimateCost(text: string, model: string, isOutput: boolean): number {
  const tokens = text.length / 4;  // ~4 chars per token
  const pricing = lookupPricing(model);
  const ratePerToken = isOutput
    ? pricing.outputPerMToken / 1_000_000
    : pricing.inputPerMToken / 1_000_000;
  return tokens * ratePerToken;
}
```

The admin dashboard shows:
- Total estimated cost across all analyses
- Per-provider cost breakdown with model-level detail
- Per-analysis cost estimate for the 25 most recent runs
- Success rates (failed calls still cost money — the provider charged for the tokens processed)

**Important limitation**: Extraction and recommendation calls are not stored as `Response` rows (they use `completePreferringGemini()`, not the search path). The admin dashboard only shows search call costs. Actual spend is 1.5–2× what the dashboard reports.

---

## Estimated Per-Analysis Cost at Defaults

With Gemini + OpenAI + Claude + Groq all enabled:

| Step | Calls | Avg tokens | Model | Est. cost |
|---|---|---|---|---|
| Search (OpenAI) | 12 | 1,000 in + 800 out | gpt-4o | ~$0.038 |
| Search (Gemini) | 12 | 1,000 in + 800 out | gemini-2.0-flash | ~$0.003 |
| Search (Claude) | 12 | 1,000 in + 800 out | claude-sonnet-4 | ~$0.050 |
| Search (Groq) | 12 | 1,000 in + 800 out | groq/compound | ~$0.002 |
| Extraction (Gemini) | 48 | 1,500 in + 200 out | gemini-2.0-flash | ~$0.008 |
| Structural (Gemini) | 4 | ~1,000 in + 600 out | gemini-2.0-flash | ~$0.001 |
| **Total** | | | | **~$0.10** |

Roughly **$0.10 per analysis** with all 4 providers. If you drop Claude (most expensive), you're at ~$0.05.

This is why the "all providers are soft-fail" architecture matters: if Claude's key expires or gets rate-limited, the system falls back gracefully rather than failing analyses and generating refund requests.

---

## What's Missing: Proactive Cost Controls

The current implementation is reactive (observe after the fact) rather than preventive. Missing capabilities that would matter at scale:

### Budget Caps
There's no maximum spend limit per analysis or per user per day. A user who submits 100 analyses overnight could generate $10+ in LLM costs with no alert.

**What to add**: A `dailyCostLimit` per user in the DB, checked before enqueuing jobs. If the estimated cost would exceed the limit, reject the job with a friendly message.

### Caching Identical Responses
Two users who analyze the same company get identical prompts (since prompt generation is deterministic for the same company name + context). But there's no cache — both analyses fire all 48 search calls independently.

**What to add**: Cache the raw search responses by `(prompt_text, provider, date)`. If the same prompt was already searched today on the same provider, reuse the cached response. Cache hit saves 1 LLM call (~$0.001–0.008).

### Extraction Batching
Extraction currently makes one LLM call per `Response` row (48 calls). A single Gemini call can extract from 10+ responses simultaneously:

```
"Extract brand visibility data from each of these 10 AI responses:
Response 1: ...
Response 2: ...
..."
```

This would reduce extraction from 48 calls to 5, cutting extraction cost by ~90%.

### Cheaper Extraction Model
The extraction task is simple and deterministic. `gemini-2.0-flash` is already cheap, but there are even cheaper options:
- Groq's `llama-3.1-8b-instant` is free-tier accessible and likely sufficient for extraction
- Local models via Ollama (zero cost) for teams running on-prem

The current `completePreferringGemini()` preference order would need a cheap-model override path for extraction specifically.
