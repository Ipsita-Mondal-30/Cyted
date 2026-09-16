# Full Lifecycle of a Single Visibility Analysis

This traces every line of code touched from the moment a user submits the form to the moment the report renders. Nothing is skipped.

---

## Phase 0: Form Submission

**Component**: `src/components/AnalyzeForm.tsx`

The user fills in company name, website, description, and competitors. On submit:

```typescript
// AnalyzeForm.tsx
const res = await fetch("/api/analysis/create", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ companyName, website, description, competitors }),
});
const { jobId } = await res.json();
router.push(`/dashboard/${jobId}`);
```

The browser immediately navigates to the dashboard before the analysis has even started.

---

## Phase 1: Job Creation

**Route**: `src/app/api/analysis/create/route.ts`

```
POST /api/analysis/create
```

1. `requireUser(request)` — validates the Supabase session cookie via a network call to Supabase. Upserts the `User` row in Postgres if it doesn't exist.

2. Zod validation of the request body.

3. `prisma.company.upsert` — one company per user. Either creates or updates the company record with the latest input.

4. `prisma.analysisJob.create` — snapshot of all inputs:
   ```typescript
   {
     userId, companyId,
     companyName, website, description,
     competitors: competitorArray,  // JSON
     status: "QUEUED",
     progress: 0,
   }
   ```

5. `enqueueAnalysis(analysisId)` — pushes a BullMQ job:
   ```typescript
   await queue.add("run", { analysisId }, {
     jobId: analysisId,           // idempotent: same ID = same job
     attempts: MAX_RETRIES + 1,   // default: 3 attempts
     backoff: { type: "exponential", delay: 2000 }
   });
   ```

6. Returns `{ jobId }`. Total time: ~150ms.

---

## Phase 2: UI Polling Begins

**Component**: `src/components/AnalysisDashboard.tsx`

The dashboard mounts and starts a polling loop:

```typescript
useEffect(() => {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout>;

  async function tick() {
    const s = await loadStatus(); // GET /api/analysis/status/[jobId]
    setStatus(s);

    if (s.status === "COMPLETED" || s.status === "FAILED") {
      const r = await loadResults(); // GET /api/analysis/results/[jobId]
      setResults(r);
      return; // stop polling
    }

    timer = setTimeout(tick, 2000); // poll again in 2 seconds
  }

  tick();
  return () => { cancelled = true; clearTimeout(timer); };
}, [jobId]);
```

The UI shows a progress bar bound to `status.progress` and the text from `status.progressMessage`.

---

## Phase 3: Worker Picks Up the Job

**File**: `src/workers/analysis.worker.ts`

The worker is a long-running Node.js process. BullMQ dequeues the job and calls `processAnalysis(job)`.

```typescript
const worker = new Worker("analysis", processAnalysis, {
  connection: getRedisConnectionOptions(),
  concurrency: 1,
  lockDuration: 600_000, // 10 minutes
});
```

### Pre-flight checks

```typescript
await ensurePrismaConnected(); // SELECT 1 — reconnects if needed

const analysis = await prisma.analysisJob.findUnique({
  where: { id: analysisId }
});

// Clean slate for retries — delete all prior attempt data in one transaction
await prisma.$transaction([
  prisma.extractedResult.deleteMany({ where: { response: { analysisId } } }),
  prisma.response.deleteMany({ where: { analysisId } }),
  prisma.prompt.deleteMany({ where: { analysisId } }),
  prisma.metrics.deleteMany({ where: { analysisId } }),
  prisma.recommendation.deleteMany({ where: { analysisId } }),
]);

// Mark as PROCESSING
await prisma.analysisJob.update({
  where: { id: analysisId },
  data: { status: "PROCESSING", progress: 5, error: null }
});
```

---

## Phase 4: Step 0 — Brand Resolution (5%)

**Service**: `src/lib/services/competitor.service.ts`

The raw user input might have typos (`acme corp` → `Acme Corp`), wrong capitalization, or an incomplete competitor list. The worker asks the LLM to clean this up.

```typescript
const resolved = await resolveBrandsAndCompetitors({
  companyName: analysis.companyName,
  website: analysis.website,
  description: analysis.description,
  competitors: seedCompetitors,
});
```

Internally, this calls `completePreferringGemini()` with a prompt like:

```
You are a brand research assistant. Given:
  Company: "acme corp"
  Website: "acme.com"
  Known competitors: ["rival inc", "otherco"]

Return JSON:
{
  "companyName": "corrected name",
  "domain": "acme.com",
  "competitors": ["Rival Inc", "OtherCo", ...],
  "competitorDomains": { "Rival Inc": "rival.com" },
  "discoveredCompetitors": ["Brand X", "Brand Y"],  // up to 5 real competitors the user didn't list
  "corrections": [...]
}
```

The response is parsed and stored:
```typescript
await prisma.analysisJob.update({
  where: { id: analysisId },
  data: { companyName: resolved.companyName, competitors: resolved.competitors }
});
```

Brand logo URLs are built from domains using Clearbit:
```typescript
brandLogos = { "Acme Corp": "https://logo.clearbit.com/acme.com" }
```

**Soft-fail**: if this step throws (LLM unavailable, bad JSON), it logs a warning and continues with the original user input. The analysis doesn't fail.

---

## Phase 5: Step 1 — Company Context (10–20%)

**Service**: `src/lib/services/prompt.service.ts` → `buildCompanyContext()`

Asks the LLM to build a structured profile of the company. This feeds into prompt generation.

```typescript
const context = await buildCompanyContext({
  companyName,
  website,
  description,
  competitors,
});
// Returns:
// {
//   industry: "CRM Software",
//   products: ["Sales CRM", "Marketing Hub"],
//   services: ["Onboarding", "Support"],
//   audience: ["SMBs", "Sales teams"],
//   useCases: ["Lead tracking", "Pipeline management"],
//   keywords: ["crm", "sales software", "pipeline"]
// }
```

The context is merged with brand logos and stored in `AnalysisJob.companyContext`:
```typescript
await prisma.analysisJob.update({
  data: { companyContext: { ...context, brandLogos, brandDomains } }
});
```

---

## Phase 6: Step 2 — Prompt Generation (20–40%)

**Service**: `src/lib/services/prompt.service.ts` → `generateAndStorePrompts()`

Generates realistic buyer-intent search queries using the company context.

```typescript
const promptCount = await generateAndStorePrompts(analysisId, companyName, context);
```

With default config (6 categories × 2 prompts = 12 prompts), the LLM generates queries like:

```
Category: Comparison  → "Best CRM alternatives to Acme Corp for small teams"
Category: Comparison  → "Acme Corp vs Rival Inc — which is better for B2B sales?"
Category: Buying      → "Is Acme Corp worth it for a 50-person sales team?"
Category: Pricing     → "How much does Acme Corp cost compared to competitors?"
Category: Reviews     → "What do users say about Acme Corp?"
Category: Features    → "Does Acme Corp have pipeline automation?"
Category: Alternatives → "What can I use instead of Acme Corp?"
...
```

Each is stored as a `Prompt` row: `{ analysisId, category, prompt }`.

---

## Phase 7: Step 3 — Provider Search (40–65%)

**Service**: `src/lib/services/search.service.ts`

This is the core of the system. Every prompt is sent to every enabled LLM provider with web search enabled.

```typescript
const providers = await getEnabledProviders();  // [openai, gemini, claude, groq]
const prompts = await prisma.prompt.findMany({ where: { analysisId } });

await searchAllProviders(analysisId, prompts, progressCallback);
```

Inside `searchAllProviders`:
```typescript
// All providers run in parallel
await Promise.all(
  providers.map(provider =>
    runProviderWithConcurrency(provider, prompts, analysisId, semaphore)
  )
);
```

Each provider call:
1. Sends the prompt with web search enabled (Grounding / web_search / compound model)
2. Times latency
3. Stores the result as a `Response` row — including error rows

```typescript
try {
  const result = await withRetries(() => provider.search(prompt.prompt));
  await prismaWrite(() => prisma.response.create({
    data: {
      analysisId,
      promptId: prompt.id,
      provider: result.provider,
      model: result.model,
      rawResponse: result.rawResponse,
      latencyMs: result.latencyMs,
    }
  }));
} catch (err) {
  await prismaWrite(() => prisma.response.create({
    data: {
      analysisId, promptId: prompt.id,
      provider: provider.name, model: provider.model,
      error: err.message,
    }
  }));
}
```

Progress fires after each completed call:
```
progress = 40 + Math.floor((done / total) * 25)
// At 4/48 calls done: 40 + floor(4/48 * 25) = 42%
// At 48/48 calls done: 65%
```

---

## Phase 8: Step 4 — Extraction (70–85%)

**Service**: `src/lib/services/extraction.service.ts`

Each raw LLM response is fed back to another LLM to extract structured signal.

```typescript
const responses = await prisma.response.findMany({
  where: { analysisId, error: null },  // skip failed responses
  select: { id: true, rawResponse: true }
});

await mapWithConcurrency(responses, extractConcurrency, async (response) => {
  const extracted = await completePreferringGemini(
    EXTRACTION_SYSTEM_PROMPT,
    buildExtractionPrompt(response.rawResponse, companyName, competitors)
  );
  // Parse JSON from extracted text
  await prismaWrite(() => prisma.extractedResult.create({
    data: {
      responseId: response.id,
      mentionedBrands: parsed.mentionedBrands,
      mentionedProducts: parsed.mentionedProducts,
      citations: parsed.citations,
      ranking: parsed.ranking,
      reasoning: parsed.reasoning,
      sentiment: parsed.sentiment,
    }
  }));
});
```

The extraction prompt is explicit:
```
Given this AI response about a query, extract brand visibility data.
Target company: "Acme Corp"
Competitors: ["Rival Inc", "OtherCo"]

Return JSON:
{
  "mentionedBrands": ["Acme Corp"],       // all brands named in the response
  "mentionedProducts": ["Acme Sales CRM"],
  "citations": ["https://acme.com"],
  "ranking": 1,                           // 1-based position in any ranked list, null if not ranked
  "sentiment": "Positive",               // toward Acme Corp specifically
  "reasoning": "Acme was listed first and described as the top choice"
}
```

---

## Phase 9: Step 5 — Metrics Calculation (90%)

**Service**: `src/lib/services/metrics.service.ts`

Pure in-process computation. No LLM calls. Reads all `ExtractedResult` rows.

```typescript
const extractions = await prisma.extractedResult.findMany({
  where: { response: { analysisId } },
  include: { response: { include: { prompt: true } } }
});

const mentionRate = uniquePromptsWithMention / totalUniquePrompts * 100;
const shareOfVoice = companyMentions / totalBrandMentions * 100;
const citationRate = mentionsWithCitations / companyMentions * 100;
const recommendationRate = positiveOrTopRankedMentions / totalExtractions * 100;
const visibilityScore =
  mentionRate * 0.35 +
  shareOfVoice * 0.25 +
  recommendationRate * 0.25 +
  citationRate * 0.10 +
  rankingScore * 0.05;

await prisma.metrics.upsert({ where: { analysisId }, data: { ...scores } });
```

---

## Phase 10: Step 6 — Recommendations (95–100%)

**Service**: `src/lib/services/recommendation.service.ts`

The metrics are assembled into a prompt asking the LLM to write a strategic report.

```typescript
const rec = await generateAndStoreRecommendations(analysisId, companyName, competitors);
```

The LLM returns a delimited response:
```
===MARKDOWN===
## Your AI Visibility Report

Your brand appeared in 83% of queries...
[full strategic markdown]

===SUGGESTIONS===
[
  { "type": "Comparison Article", "title": "...", "keywords": [...], "estimatedImpact": "High" },
  ...
]
```

Stored as `Recommendation.content = JSON.stringify({ markdown, contentSuggestions })`.

**Soft-fail**: if recommendations fail, the job still completes with a warning.

Final state update:
```typescript
await prisma.analysisJob.update({
  data: {
    status: "COMPLETED",
    progress: 100,
    completedAt: new Date(),
    warnings: collectedWarnings,
  }
});
```

---

## Phase 11: UI Detects Completion

On the next 2-second poll, the status response comes back with `status: "COMPLETED"`. The dashboard:

1. Calls `GET /api/analysis/results/[jobId]`
2. The route fetches the full job with all relations via a single Prisma query with deep includes
3. `serializeAnalysisReport()` flattens the result, extracts hidden metrics, rebuilds logo URLs
4. Returns the full `ResultsPayload` JSON
5. `AnalysisDashboard` renders all sections: ranking hero, metric cards, charts, content suggestions, markdown report

**Total wall clock time**: typically 45–90 seconds from form submission to rendered report.

---

## End-to-End Timeline (Typical)

```
t=0s      Form submitted → job created, queued → browser redirects
t=0.1s    Worker picks up job (assuming idle)
t=3s      Brand resolution complete (1 LLM call)
t=8s      Company context built (1 LLM call)
t=15s     12 prompts generated (1 LLM call)
t=15–55s  48 LLM search calls across 4 providers (parallel, ~40s wall clock)
t=55–70s  48 extraction calls (parallel, ~15s wall clock)
t=72s     Metrics calculated (in-process, <1s)
t=77s     Recommendations generated (1 LLM call)
t=78s     Job marked COMPLETED
t=80s     UI polls, detects COMPLETED, fetches results, renders report
```
