# Rate Limits and Retry Strategy

## The Rate Limit Landscape

Each provider has different rate limit dimensions:

| Provider | Primary Limit | Secondary Limit | Notes |
|---|---|---|---|
| OpenAI | Requests per minute (RPM) | Tokens per minute (TPM) | Tier-based; Tier 1: 500 RPM / 30k TPM |
| Gemini | Requests per minute (RPM) | Requests per day (RPD) | Flash: 15 RPM free, 1000 RPM paid |
| Claude | Requests per minute (RPM) | Tokens per minute (TPM) | 50 RPM / 40k TPM on base tier |
| Groq | Requests per minute (RPM) | Tokens per day (TPD) | Compound: ~30 RPM on free tier |

A full analysis at defaults: 12 prompts × 4 providers = 48 search calls, plus ~70 `complete()` calls for context, extraction, and recommendations. This happens over ~60 seconds of wall clock time. At peak, the system may be firing 4–8 API calls per second across all providers.

---

## The Retry Implementation

**File**: `src/lib/utils/retry.ts`

All LLM calls (both `search()` and `complete()`) go through `withRetries()`:

```typescript
export async function withRetries<T>(
  fn: () => Promise<T>,
  options: {
    retries: number;         // from MAX_RETRIES env var, default: 2
    onRetry?: () => Promise<void>;
  }
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < options.retries) {
        // Exponential backoff: 1s, 2s, 4s (capped at 8s)
        const delayMs = Math.min(1000 * Math.pow(2, attempt), 8000);
        await sleep(delayMs);
        await options.onRetry?.();
      }
    }
  }

  throw lastError;
}
```

**Strategy: exponential backoff with a cap of 8 seconds.**

Attempt sequence with `MAX_RETRIES=2` (3 total attempts):
```
Attempt 1 → fail → wait 1s
Attempt 2 → fail → wait 2s
Attempt 3 → fail → throw
```

With `MAX_RETRIES=4` (5 total attempts, configurable):
```
Attempt 1 → fail → wait 1s
Attempt 2 → fail → wait 2s
Attempt 3 → fail → wait 4s
Attempt 4 → fail → wait 8s
Attempt 5 → fail → throw
```

The cap at 8 seconds prevents a single call from blocking the pipeline for too long. Rate limit errors from OpenAI often come with `Retry-After` headers, but the system doesn't parse those — it uses its own backoff schedule.

---

## Where Rate Limit Errors Actually Land

There are three levels where a rate limit error can be caught:

### Level 1: Individual Provider Call (search.service.ts)

```typescript
try {
  const result = await withRetries(() => provider.search(prompt));
  await prismaWrite(() => prisma.response.create({ data: { ...result } }));
} catch (err) {
  // All retries exhausted. Store the failure — don't rethrow.
  await prismaWrite(() => prisma.response.create({
    data: { ..., error: err.message }
  }));
}
```

**Outcome**: One `Response` row is stored with `error` set. The search step continues. Other prompts, other providers — unaffected.

### Level 2: `completePreferringGemini()` Fallback Chain (structural tasks)

For extraction, context-building, recommendations — rate limits on the primary provider trigger the fallback:

```typescript
for (const provider of [gemini, groq, openai, claude]) {
  try {
    const text = await provider.complete(system, user);
    return { text, provider: provider.name, model: provider.model };
  } catch (error) {
    log.warn("LLM complete failed — trying next provider", {
      provider: provider.name,
      error: error.message,
    });
    // continue to next provider
  }
}
throw new Error("All LLM providers failed");
```

If Gemini hits a quota limit on extraction call #30, the system falls back to Groq for the remaining calls without any operator intervention. The fallback is transparent.

**Outcome**: The task completes using a different provider. The `reasoning` field in `ExtractedResult` won't note which provider did the extraction (it's stored separately as a log, not in the DB).

### Level 3: BullMQ Job Retry (catastrophic failure)

If something causes the entire job to throw (e.g. all providers are exhausted simultaneously), BullMQ retries the whole job:

```
Attempt 1: all 4 providers at rate limit → job throws
Wait 2 seconds (BullMQ exponential backoff)
Attempt 2: some providers recovered → job proceeds
```

**Outcome**: The job succeeds on a retry. The UI shows "PROCESSING" throughout.

---

## Rate Limit Prevention

The retry strategy handles rate limits reactively. The concurrency controls handle them proactively:

### Per-Provider Concurrency

```typescript
const PER_PROVIDER_CONCURRENCY = 2; // default
```

At any given moment, there are at most 2 in-flight requests to each provider. With a ~5s average response time, this means roughly 0.4 requests per second per provider — well within burst limits.

### Global Search Concurrency

```typescript
const SEARCH_CONCURRENCY = 4; // default
```

Total in-flight requests across all providers: at most 4. Combined with per-provider limits, the actual peak rate is bounded.

### The Groq-Specific Hard Limit

Groq's compound model is particularly sensitive to long prompts. The provider truncates inputs before sending:

```typescript
// groq.ts
const MAX_SEARCH_CHARS = 4000;
const MAX_COMPLETE_CHARS = 24000;

const safePrompt = prompt.slice(0, MAX_SEARCH_CHARS);
```

This prevents 413 (Request Too Large) errors before they happen, which would otherwise consume retry budget without benefit.

---

## What Happens During a Multi-Job Rate Limit Storm

If 5 users submit analyses simultaneously:

```
All 5 jobs queued in Redis

Worker concurrency: 1 (only 1 job runs at a time)
      │
      ▼
Job 1 runs: 48 OpenAI calls over 60 seconds
      │
      ▼
Job 2 runs: 48 OpenAI calls — OpenAI may now throttle (RPM limit exceeded)
```

The current architecture does NOT solve rate limit pressure from multiple concurrent jobs well. With worker `concurrency: 1`, only one job runs at a time, which buys time for provider limits to reset. But if jobs queue up faster than one per 60–90 seconds, backpressure builds.

**Current mitigation**: The queue itself provides natural pacing. A job takes ~60s; the next job starts immediately after. At default settings, this is ~1 job per minute per worker, which comfortably stays under provider limits.

**Under high load**: You would need either (a) per-provider rate limiting at the search service level (track calls per minute, insert `sleep()` when approaching limits) or (b) multiple worker instances with each worker assigned to a subset of providers. Neither is currently implemented.

---

## OpenAI Specifically: Backoff on 429

OpenAI's 429 responses include a `Retry-After` header. The current `withRetries()` implementation ignores this header and uses its own 1s/2s/4s schedule. This means:

- If OpenAI says "retry after 20 seconds," the system will retry after 1 second (fail), then 2 seconds (fail), then 4 seconds (fail), then give up
- The correct behavior would be to parse the header and wait 20 seconds

This is a known gap. For most tiers, the rate limit resets faster than 4 seconds anyway (per-request limits, not per-minute throttling). But for sustained high load, reading the `Retry-After` header would improve success rates significantly.

---

## Summary: Three-Layer Defense

```
Layer 1: Prevention
  - Per-provider concurrency: 2 simultaneous calls per provider
  - Global concurrency cap: 4 total simultaneous calls
  - Hard prompt truncation (Groq): prevents 413 errors

Layer 2: Recovery (individual call)
  - withRetries(): exponential backoff (1s → 2s → 4s)
  - MAX_RETRIES=2 (3 attempts total, configurable)
  - Failures stored as error Response rows, not job failures

Layer 3: Recovery (structural tasks)
  - completePreferringGemini() fallback chain
  - Gemini → Groq → OpenAI → Claude automatic fallover
  - No operator intervention required

Layer 4: Recovery (catastrophic)
  - BullMQ job-level retry with exponential backoff (2s → 4s → 8s)
  - Up to 3 job attempts by default
  - Clean slate retry (prior data deleted before re-attempt)
```
