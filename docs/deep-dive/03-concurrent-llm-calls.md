# Concurrent LLM Calls — How the Fan-Out Works

## The Shape of the Problem

A default analysis generates 12 prompts across 4 providers = **48 independent LLM API calls** in Step 3. These are all network-bound and can run simultaneously, but blindly firing all 48 at once would:
- Immediately hit provider rate limits (OpenAI: 500 RPM on tier 1, but burst limits are much lower)
- Exhaust the Postgres connection pool when all 48 try to write results simultaneously
- Cause cascading failures that retry-storm into the same limits

The solution is a layered concurrency control system.

---

## Layer 1: Provider-Level Parallelism

All enabled providers run simultaneously using `Promise.all`. There's no reason to wait for OpenAI to finish before starting Gemini.

```typescript
// search.service.ts
await Promise.all(
  providers.map(provider =>
    runProviderWithConcurrency(provider, prompts, analysisId, globalSemaphore)
  )
);
```

With 4 providers, this immediately opens 4 concurrent processing "lanes."

---

## Layer 2: Per-Provider Concurrency Semaphore

Within each provider lane, a semaphore limits how many calls are in-flight to that provider at once. Default: **2 per provider**.

```typescript
async function runProviderWithConcurrency(provider, prompts, analysisId, globalSemaphore) {
  const providerSemaphore = new Semaphore(perProviderConcurrency); // default: 2

  await mapWithConcurrency(prompts, perProviderConcurrency, async (prompt) => {
    await globalSemaphore.acquire();      // check global cap
    await providerSemaphore.acquire();    // check per-provider cap
    try {
      await executeSearch(provider, prompt, analysisId);
    } finally {
      globalSemaphore.release();
      providerSemaphore.release();
    }
  });
}
```

With 4 providers × 2 concurrent calls each = up to **8 simultaneous LLM requests** in steady state. The global `searchConcurrency` cap (default: 4) keeps the total lower.

---

## Layer 3: Global Search Semaphore

A top-level semaphore caps the total in-flight calls across all providers.

```typescript
const globalSemaphore = new Semaphore(searchConcurrency); // default: 4 (= CONCURRENT_REQUESTS)
```

This prevents the worker from opening too many outbound connections simultaneously, which matters when running on low-memory machines or when Postgres connection limits are low.

---

## What Concurrency Looks Like in Practice

With defaults (12 prompts, 4 providers, searchConcurrency=4, perProviderConcurrency=2):

```
t=0s:   All 4 provider lanes start simultaneously
        OpenAI starts prompts 1, 2     (perProvider=2)
        Gemini starts prompts 1, 2     (perProvider=2)
        Claude waits (global cap=4 reached)
        Groq waits   (global cap=4 reached)

t=2s:   OpenAI prompt 1 finishes → writes Response → starts prompt 3
        Global cap frees 1 slot → Claude starts prompt 1

t=4s:   OpenAI prompt 2 finishes → starts prompt 4
        ...

[continues until all 48 calls complete]
```

Wall-clock time is approximately:
- `ceil(12 / 2) = 6 batches per provider`
- Each batch ~5s average
- All providers parallel: ~30–40s total
- Plus write time: negligible

---

## What Happens When One Provider Times Out

Each `provider.search(prompt)` call is wrapped with `withRetries()`:

```typescript
// retry.ts
export async function withRetries<T>(
  fn: () => Promise<T>,
  options: { retries: number; onRetry?: () => void }
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < options.retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
        await sleep(delay);
        await options.onRetry?.();
      }
    }
  }
  throw lastError;
}
```

With `MAX_RETRIES=2`, the call sequence for a timeout looks like:
```
Attempt 1 → timeout after 30s → wait 1s
Attempt 2 → timeout again    → wait 2s
Attempt 3 → timeout again    → throw
```

After all retries are exhausted, the error is **caught at the provider level**, not propagated:

```typescript
try {
  const result = await withRetries(() => provider.search(prompt.prompt), {
    retries: config.maxRetries
  });
  await prismaWrite(() => prisma.response.create({ data: { ...result } }));
} catch (err) {
  // Store the failure — don't throw
  await prismaWrite(() => prisma.response.create({
    data: {
      analysisId, promptId: prompt.id,
      provider: provider.name, model: provider.model,
      error: err instanceof Error ? err.message : String(err),
      // rawResponse: null, latencyMs: null
    }
  }));
}
```

Key point: **a failed provider call does not fail the job**. The `Response` row is stored with `error` set. The extraction step skips rows with errors. The metrics calculation works with the responses that succeeded. The analysis completes with potentially fewer data points, but it completes.

---

## What Happens When One Provider Errors (4xx, 5xx, malformed)

Same path as timeout. `withRetries` retries on any thrown error, then the catch block stores the error response. The specific error message is preserved in `Response.error` for the admin dashboard.

Some provider-specific handling:

**Groq 413 (payload too large)**: The Groq provider has a hard truncation before sending:
```typescript
// groq.ts
const truncatedPrompt = prompt.slice(0, 4000); // hard limit
```
And falls back to the lighter complete model if compound 413s:
```typescript
try {
  return await searchWithCompoundModel(truncatedPrompt);
} catch (err) {
  if (err.status === 413) {
    return await searchWithCompleteModel(truncatedPrompt); // fallback
  }
  throw err;
}
```

**Gemini quota exhausted**: Gemini is the most commonly rate-limited provider because it's also used for all `complete()` calls (context, extraction, recommendations). If Gemini's search quota is exhausted, the retry loop eventually gives up and stores an error response. The `completePreferringGemini()` fallback chain picks up Groq/OpenAI for the structural tasks.

**Claude web search unavailable**: Claude's `web_search_20250305` tool is relatively new and occasionally unavailable. The error is stored; the analysis continues with responses from other providers.

---

## What Happens to the Metrics With Missing Responses

Say Claude times out on all 12 prompts. You have 36 responses (OpenAI + Gemini + Groq) instead of 48. The metrics still compute normally — they work over the set of successful `ExtractedResult` rows, not over a fixed denominator.

The admin usage dashboard shows the failure rate per provider, which makes this pattern visible:
```json
{
  "name": "claude",
  "calls": 12,
  "successRate": 0.0,   // all failed
  "avgLatencyMs": null
}
```

The analysis UI shows the participating providers via `AiProviderStrip` — if Claude failed all 12 calls, it won't appear in the strip (the list is derived from successful `Response` rows).

---

## The DB Write Problem

48 LLM calls finishing roughly simultaneously means 48 `prisma.response.create()` calls hitting Postgres at nearly the same time. Without limiting, this exhausts the connection pool.

`prismaWrite()` provides a second-level semaphore specifically for DB writes:

```typescript
const MAX_PARALLEL_WRITES = 2;
const writeSemaphore = new Semaphore(MAX_PARALLEL_WRITES);

export async function prismaWrite<T>(fn: () => Promise<T>): Promise<T> {
  await writeSemaphore.acquire();
  try {
    return await withRetries(fn, {
      retries: 4,
      onRetry: async () => {
        await prisma.$disconnect();
        await prisma.$connect();
      }
    });
  } finally {
    writeSemaphore.release();
  }
}
```

Max 2 parallel writes ensures the connection pool (size: 5) is never exhausted by the worker alone. The remaining connections are available for the web server.
