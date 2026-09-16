# Dataflow

This document traces every data path through the system — from a user filling out the form all the way to a rendered report. It covers both the happy path and error/retry paths.

---

## End-to-End Flow Overview

```
User fills form
      │
      ▼
POST /api/analysis/create
      │  creates AnalysisJob (QUEUED)
      │  enqueues BullMQ job
      │
      ▼
Browser redirects to /dashboard/[jobId]
      │
      ▼
UI polls GET /api/analysis/status/[jobId] every 2s
      │
      │    (in parallel, on a separate process)
      │
      ▼
Worker picks up job from Redis queue
      │
      ├─ Step 0: Brand Resolution        (progress: 5%)
      ├─ Step 1: Company Context         (progress: 10–20%)
      ├─ Step 2: Prompt Generation       (progress: 20–40%)
      ├─ Step 3: Provider Search         (progress: 40–65%)
      ├─ Step 4: Extraction              (progress: 70–85%)
      ├─ Step 5: Metrics Calculation     (progress: 90%)
      └─ Step 6: Recommendations         (progress: 95–100%)
            │
            ▼
      status = COMPLETED
            │
      UI detects COMPLETED on next poll
            │
            ▼
      GET /api/analysis/results/[jobId]
            │
            ▼
      AnalysisDashboard renders full report
```

---

## Phase 1: Job Creation

**Files**: `src/app/api/analysis/create/route.ts`, `src/queue/queue.ts`

```
Browser                    Next.js API                     Database           Redis
   │                           │                               │                 │
   │── POST /api/analysis/create ──►│                          │                 │
   │   { companyName, website,  │                              │                 │
   │     description,           │                              │                 │
   │     competitors[] }        │                              │                 │
   │                            │── requireUser() ────────────►│                 │
   │                            │◄─ { userId } ───────────────│                 │
   │                            │                              │                 │
   │                            │── upsert Company ───────────►│                 │
   │                            │◄─ { companyId } ────────────│                 │
   │                            │                              │                 │
   │                            │── create AnalysisJob ────────►│                 │
   │                            │   status: QUEUED              │                 │
   │                            │◄─ { jobId } ────────────────│                 │
   │                            │                              │                 │
   │                            │── queue.add("run", { analysisId }) ───────────►│
   │                            │                              │                 │
   │◄── 200 { jobId } ─────────│                              │                 │
   │                            │                              │                 │
   │── redirect to /dashboard/[jobId]                          │                 │
```

**What's written to the database at this point:**
- `Company` row upserted (one per user) with latest name, website, description, competitors
- `AnalysisJob` row created with `status: QUEUED`, `progress: 0`, all input fields snapshotted

---

## Phase 2: UI Polling

**Files**: `src/components/AnalysisDashboard.tsx`, `src/app/api/analysis/status/[jobId]/route.ts`

```
Browser (AnalysisDashboard)           Next.js API              Database
          │                                │                       │
          │── GET /api/analysis/status ───►│                       │
          │   every 2 seconds              │── findUnique ─────────►│
          │                                │◄─ { status, progress, │
          │◄── { status, progress,         │    progressMessage,   │
          │     progressMessage, error }   │    error, warnings }  │
          │                                │                       │
          │   if status == COMPLETED or FAILED:                    │
          │── GET /api/analysis/results ──►│                       │
          │                                │── findUnique          │
          │                                │   (full join) ────────►│
          │◄── full ResultsPayload ────────│                       │
          │                                │                       │
          │  renders full report           │                       │
```

The UI shows:
- A progress bar (0–100)
- The current `progressMessage` (e.g. "Searching AI providers (4/12)")
- Any warnings as banners
- The full report once COMPLETED

On errors: poll interval doubles to 4 seconds and retries indefinitely.

---

## Phase 3: Worker Pipeline

**File**: `src/workers/analysis.worker.ts`

The worker is a separate Node.js process. It dequeues jobs from Redis and runs the analysis pipeline. Each step writes incrementally to the database so the UI always reflects current state.

### Step 0 — Brand Resolution (5%)

**Service**: `src/lib/services/competitor.service.ts`

```
Worker                    LLM (Gemini/fallback)           Database
  │                              │                            │
  │── buildPrompt(companyName,   │                            │
  │    website, competitors)     │                            │
  │── completePreferringGemini() ►│                            │
  │                              │── web completion           │
  │◄── JSON response ────────────│                            │
  │    {                         │                            │
  │      companyName: corrected  │                            │
  │      domain: "acme.com"      │                            │
  │      competitors: [...]      │                            │
  │      competitorDomains: {...} │                           │
  │      discoveredCompetitors: []│                           │
  │      corrections: [...]      │                            │
  │    }                         │                            │
  │                              │                            │
  │── buildLogoMap(domains) ─────────────────────────────────►│ (Clearbit CDN URLs)
  │                              │                            │
  │── update AnalysisJob ────────────────────────────────────►│
  │   companyName = corrected    │                            │
  │   competitors = resolved     │                            │
  │── update Company ────────────────────────────────────────►│
```

Output: corrected `companyName`, updated `competitors[]`, `brandLogos` map (Clearbit URLs), `brandDomains` map.
Failure mode: soft-fail — continues with user-supplied input if this step throws.

---

### Step 1 — Company Context (10–20%)

**Service**: `src/lib/services/prompt.service.ts` → `buildCompanyContext()`

```
Worker                    LLM (Gemini/fallback)           Database
  │                              │                            │
  │── completePreferringGemini() ►│                            │
  │   "Return a JSON company     │                            │
  │    profile for {companyName}"│                            │
  │                              │                            │
  │◄── JSON context ─────────────│                            │
  │    {                         │                            │
  │      industry, products[],   │                            │
  │      services[], audience[], │                            │
  │      useCases[], keywords[]  │                            │
  │    }                         │                            │
  │                              │                            │
  │── merge brandLogos/Domains   │                            │
  │── update AnalysisJob ────────────────────────────────────►│
  │   companyContext = { ...context, brandLogos, brandDomains }
```

Output: rich company profile used to inform prompt generation.

---

### Step 2 — Prompt Generation (20–40%)

**Service**: `src/lib/services/prompt.service.ts` → `generateAndStorePrompts()`

```
Worker                    LLM (Gemini/fallback)           Database
  │                              │                            │
  │── completePreferringGemini() ►│                            │
  │   "Generate N prompts per    │                            │
  │    category using context"   │                            │
  │   categories: [Comparison,   │                            │
  │    Buying, Pricing, Reviews, │                            │
  │    Features, Alternatives]   │                            │
  │                              │                            │
  │◄── [{ category, prompt }]────│                            │
  │    (default: 6×2 = 12 total) │                            │
  │                              │                            │
  │── createMany(Prompt[]) ──────────────────────────────────►│
  │   { analysisId, category,    │                            │
  │     prompt }                 │                            │
```

Output: 12 `Prompt` rows (by default) covering branded and unbranded buyer queries.

---

### Step 3 — Provider Search (40–65%)

**Service**: `src/lib/services/search.service.ts`

This is the most parallelized step. Each prompt is sent to every enabled provider simultaneously.

```
Worker
  │
  │── getEnabledProviders()  ──► [openai, gemini, claude, groq]
  │── load all Prompt rows
  │
  │── searchAllProviders(prompts, providers)
  │
  │   For each (prompt × provider) in parallel:
  │   ┌─────────────────────────────────────────────────────────────┐
  │   │                                                             │
  │   │  Prompt: "What is the best CRM for small teams?"           │
  │   │                                                             │
  │   │  ──► OpenAI.search(prompt)  ──► OpenAI API (web search)    │
  │   │  ──► Gemini.search(prompt)  ──► Gemini API (grounding)     │
  │   │  ──► Claude.search(prompt)  ──► Claude API (web search)    │
  │   │  ──► Groq.search(prompt)    ──► Groq compound model        │
  │   │                                                             │
  │   │  Each returns: { rawResponse, latencyMs, model, provider } │
  │   │                                                             │
  │   │  prismaWrite() → create Response row (success or error)    │
  │   └─────────────────────────────────────────────────────────────┘
  │
  │   Concurrency controls:
  │   - All providers run in parallel (Promise.all)
  │   - Each provider has its own semaphore (perProviderConcurrency, default: 2)
  │   - Total in-flight calls capped by searchConcurrency (default: 4)
  │   - Progress callback fires after each batch: progress = 40 + (done/total × 25)
```

Output: `prompts.length × providers.length` `Response` rows. With defaults (12 prompts × 4 providers = 48 responses).

---

### Step 4 — Extraction (70–85%)

**Service**: `src/lib/services/extraction.service.ts`

A second LLM pass over every successful Response to extract structured brand signal.

```
Worker
  │
  │── load all Response rows where error IS NULL
  │
  │   For each Response (with concurrency: extractConcurrency, default: 3):
  │   ┌────────────────────────────────────────────────────────────────┐
  │   │                                                                │
  │   │  rawResponse: "Acme CRM is a top choice for SMBs. Rival also  │
  │   │  scores well. See acme.com for pricing..."                     │
  │   │                                                                │
  │   │  ──► completePreferringGemini(extractionPrompt)               │
  │   │      "Given this AI response, extract brand mentions..."       │
  │   │                                                                │
  │   │  ◄── JSON:                                                     │
  │   │      {                                                         │
  │   │        mentionedBrands: ["Acme", "Rival"],                    │
  │   │        mentionedProducts: ["Acme CRM"],                       │
  │   │        citations: ["https://acme.com"],                       │
  │   │        ranking: 1,                                             │
  │   │        reasoning: "Acme was listed first",                    │
  │   │        sentiment: "Positive"                                   │
  │   │      }                                                         │
  │   │                                                                │
  │   │  prismaWrite() → create ExtractedResult row                   │
  │   └────────────────────────────────────────────────────────────────┘
  │
  │   Progress callback: progress = 70 + (done/total × 15)
```

Output: one `ExtractedResult` row per successful `Response`.

---

### Step 5 — Metrics Calculation (90%)

**Service**: `src/lib/services/metrics.service.ts`

Pure in-process computation — no LLM calls. Reads all `ExtractedResult` rows and derives aggregate scores.

```
Worker
  │
  │── load all ExtractedResult rows for analysisId (with Response join)
  │
  │   In-memory computation:
  │   ┌──────────────────────────────────────────────────────────────────┐
  │   │                                                                  │
  │   │  mentionRate     = prompts where company mentioned / total       │
  │   │  shareOfVoice    = company mentions / all brand mentions         │
  │   │  citationRate    = responses with citations / company mentions   │
  │   │  recRate         = responses where mentioned + (positive OR ≤3) │
  │   │  avgRanking      = mean of all non-null ranking values           │
  │   │  visibilityScore = weighted blend of above (see data-models.md) │
  │   │                                                                  │
  │   │  competitorShare = { brand: fraction, ... }                     │
  │   │  positiveSentimentRate = positive extractions / total           │
  │   │  (stored as competitorShare.__positiveSentimentRate)            │
  │   │                                                                  │
  │   └──────────────────────────────────────────────────────────────────┘
  │
  │── upsert Metrics row ──────────────────────────────────────────────►│ DB
```

Output: one `Metrics` row with all computed scores.

---

### Step 6 — Recommendations (95–100%)

**Service**: `src/lib/services/recommendation.service.ts`

```
Worker                    LLM (Gemini/fallback)           Database
  │                              │                            │
  │── load Metrics row           │                            │
  │── build report prompt        │                            │
  │   (includes all metric       │                            │
  │    values + company info)    │                            │
  │── completePreferringGemini() ►│                            │
  │                              │                            │
  │◄── delimited response ───────│                            │
  │    ===MARKDOWN===            │                            │
  │    ## Strategic Report...    │                            │
  │    ===SUGGESTIONS===         │                            │
  │    [{ type, title, ... }]    │                            │
  │                              │                            │
  │── parse sections             │                            │
  │── upsert Recommendation ────────────────────────────────►│
  │   content = JSON.stringify({ │                            │
  │     markdown, contentSuggestions })                       │
  │                              │                            │
  │── update AnalysisJob ────────────────────────────────────►│
  │   status = COMPLETED         │                            │
  │   progress = 100             │                            │
  │   completedAt = now()        │                            │
```

Failure mode: soft-fail. If this step throws, the job still completes with status `COMPLETED` and a warning in `AnalysisJob.warnings`. The UI shows the warning as a banner.

---

## Phase 4: Results Rendering

**Files**: `src/app/api/analysis/results/[jobId]/route.ts`, `src/lib/report-serialize.ts`, `src/components/AnalysisDashboard.tsx`

```
Browser                Next.js API                  Database
   │                       │                             │
   │── GET /api/analysis/  │                             │
   │   results/[jobId] ───►│                             │
   │                       │── findUnique (full join) ───►│
   │                       │   AnalysisJob               │
   │                       │     + Metrics               │
   │                       │     + Recommendation        │
   │                       │     + Prompts               │
   │                       │       + Responses           │
   │                       │         + ExtractedResults  │
   │                       │                             │
   │                       │── serializeAnalysisReport() │
   │                       │   - extract positiveSentimentRate from competitorShare
   │                       │   - rebuild brandLogos from companyContext
   │                       │   - flatten nested relations
   │                       │   - parse Recommendation.content JSON
   │                       │                             │
   │◄── ResultsPayload ────│                             │
   │    (flat JSON)        │                             │
   │                       │                             │
   │  AnalysisDashboard renders:                         │
   │  - ReportRankingHero  (competitor share of voice)   │
   │  - InsightMetricCards (4 key scores)                │
   │  - BrandLogoCarousel  (competitor logos)            │
   │  - ContentSuggestions (AI content ideas)            │
   │  - MarkdownReport     (full strategic report)       │
   │  - Raw prompt/response expandable rows (private)    │
```

---

## Error & Retry Dataflow

### BullMQ Job Retries

```
Worker fails mid-pipeline
         │
         ▼
BullMQ catches the thrown error
         │
         ▼
Marks AnalysisJob.status = FAILED
(in worker's catch block)
         │
         ▼
BullMQ re-queues with exponential backoff:
  attempt 1: immediate
  attempt 2: 2s delay
  attempt 3: 4s delay
  (maxAttempts = MAX_RETRIES + 1, default: 3)
         │
         ▼
On next attempt, worker FIRST deletes:
  - All ExtractedResult rows
  - All Response rows
  - All Prompt rows
  - All Metrics rows
  - All Recommendation rows
(clean slate via $transaction — prevents duplicates)
         │
         ▼
Restarts from Step 0
```

### LLM Call Retries (within a step)

```
provider.search(prompt) throws
         │
         ▼
withRetries() retries up to MAX_RETRIES times
Backoff: 1s → 2s → 4s (capped at 8s)
         │
         ▼
If all retries fail:
  Response row saved with error field set
  (null rawResponse, non-null error)
  Extraction step skips this row
```

### Database Write Retries

```
prismaWrite(fn) wraps every DB write:
  - Semaphore: max 2 parallel writes (prevents connection stampede)
  - 4 retries on connection errors
  - Prisma.$disconnect() + reconnect between retries
  - Exponential backoff: 200ms → 400ms → 800ms → 1600ms
```

---

## Public Report Dataflow

Sharing a completed report via `/report/[jobId]`:

```
Visitor (no auth)          Next.js API                  Database
     │                         │                             │
     │── GET /report/[jobId] ──►│ (page server component)    │
     │                         │                             │
     │   AnalysisDashboard     │                             │
     │   mode="public"         │                             │
     │                         │                             │
     │── GET /api/public/      │                             │
     │   report/[jobId] ──────►│                             │
     │                         │── findUnique               │
     │                         │   where status=COMPLETED ──►│
     │                         │── serializeAnalysisReport() │
     │                         │                             │
     │◄── ResultsPayload ──────│                             │
     │   (same shape as        │   Response cached:          │
     │    private results)     │   public, s-maxage=60,      │
     │                         │   stale-while-revalidate=300│
     │                         │                             │
     │  Renders full report    │                             │
     │  (no polling — single   │                             │
     │   load since COMPLETED) │                             │
     │  (no raw response rows  │                             │
     │   shown — private only) │                             │
```

---

## Data Lineage Summary

| Data | Written by | Read by |
|---|---|---|
| `Company` | `/api/analysis/create`, worker (Step 0) | `/api/company`, `AnalyzeForm` |
| `AnalysisJob` | `/api/analysis/create`, worker (all steps) | Status API, Results API |
| `Prompt` | Worker Step 2 | Worker Step 3, Results API |
| `Response` | Worker Step 3 | Worker Step 4, Results API, Admin usage |
| `ExtractedResult` | Worker Step 4 | Worker Step 5, Results API |
| `Metrics` | Worker Step 5 | Worker Step 6, Results API |
| `Recommendation` | Worker Step 6 | Results API |
| `SystemConfig` | `PUT /api/admin/providers` | `getProviderFlags()` (every job) |
| `User` | `requireUser()` (every auth'd API call) | Auth checks, company association |
