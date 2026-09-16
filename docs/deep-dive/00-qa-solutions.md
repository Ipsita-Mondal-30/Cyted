# Architecture Q&A — Solutions and Design Decisions

Answers to 11 key questions about how this system works, why it was built this way, and what the known gaps are.

---

## Q1: Walk me through the full lifecycle of a single "visibility analysis" request, start to finish.

**Short answer**: Form submit → API creates DB record + enqueues BullMQ job → browser polls status every 2s → separate worker process runs 6-step pipeline (brand resolution → context → prompts → LLM search × 4 providers → extraction → metrics → recommendations) → UI detects COMPLETED, fetches full results, renders report.

**Full detail**: See [`01-analysis-lifecycle.md`](./01-analysis-lifecycle.md).

**Key numbers**:
- ~150ms for the API route to create the job and return `{ jobId }`
- ~60–90 seconds wall-clock for the full pipeline
- ~80 seconds before the UI renders the finished report

---

## Q2: Why background workers instead of handling the multi-LLM calls synchronously in the request?

**Short answer**: A full analysis takes 45–90 seconds and makes ~100 LLM API calls. HTTP requests can't survive that, especially on serverless platforms with 10–300s limits. Background workers also give you durability (jobs survive crashes), retries (transparent to the user), and decoupled scaling (web and worker scale independently).

**Full detail**: See [`02-background-workers.md`](./02-background-workers.md).

**The practical summary**:

```
Synchronous approach problems:
  ❌ Vercel hobby plan: 10s timeout → instant failure
  ❌ Server restart mid-analysis → job lost, data corrupted
  ❌ Client closes tab → analysis disappears
  ❌ No fine-grained progress reporting via HTTP

Background worker wins:
  ✓ Durability: job survives any crash
  ✓ Retries: transparent to the user
  ✓ Progress: written to DB, polled by browser
  ✓ Scale: web and worker deploy independently
```

---

## Q3: How do you query 5 LLM providers concurrently, and what happens if one times out or errors?

**Short answer**: `Promise.all` fans out all providers in parallel. Each provider has its own concurrency semaphore (default: 2 in-flight calls). A global semaphore caps total simultaneous calls at 4. Timeouts and errors are caught per-call — stored as error `Response` rows — and never propagate to fail the job.

**Full detail**: See [`03-concurrent-llm-calls.md`](./03-concurrent-llm-calls.md).

**The concurrency structure**:
```
searchAllProviders()
  ├── Promise.all([
  │     runProvider(openai)  ← semaphore: max 2 calls at once
  │     runProvider(gemini)  ← semaphore: max 2 calls at once
  │     runProvider(claude)  ← semaphore: max 2 calls at once
  │     runProvider(groq)    ← semaphore: max 2 calls at once
  │   ])
  └── global semaphore: max 4 total in-flight

On timeout/error:
  withRetries() → exponential backoff (1s → 2s → 4s)
  if all retries fail:
    store Response row with error = "timeout" (not null rawResponse)
    continue — job does not fail
```

---

## Q4: How do you turn free-text LLM responses into structured, comparable data across providers?

**Short answer**: A second LLM pass (Step 4 — extraction). Every raw response is fed to `completePreferringGemini()` with a focused extraction prompt asking for strict JSON: brand mentions, product mentions, citations, ranking, and sentiment. The extraction LLM doesn't need web access — it just reads and classifies.

**Full detail**: See [`04-structured-extraction.md`](./04-structured-extraction.md).

**Why a second pass, not structured output on the first pass**:
- The search response benefits from being free-text and unconstrained (realistic buyer experience)
- Structured output is implemented differently across all 4 providers — a single extraction prompt works everywhere
- The reasoning field in the extraction output makes decisions auditable

**What the extraction returns**:
```json
{
  "mentionedBrands": ["Acme Corp", "Rival Inc"],
  "mentionedProducts": ["Acme Sales CRM"],
  "citations": ["https://acme.com/pricing"],
  "ranking": 1,
  "sentiment": "Positive",
  "reasoning": "Acme was listed as the first recommendation and described as best-in-class"
}
```

---

## Q5: What happens if two different providers disagree completely on whether a brand was "mentioned"?

**Short answer**: Both data points are stored and contribute to the aggregate metrics. There's no reconciliation. The system treats disagreement as a real signal: it means the brand has inconsistent visibility across the AI ecosystem, which is exactly what the product is designed to surface.

**Full detail**: See [`05-provider-disagreement.md`](./05-provider-disagreement.md).

**Concrete example**:
```
Prompt: "Is Acme Corp good for enterprise sales?"

OpenAI:  "Acme Corp is excellent for enterprise sales..."  → sentiment: Positive, mentioned: YES
Gemini:  "Reviews are mixed, users prefer Rival Inc..."    → sentiment: Negative, mentioned: YES  
Claude:  "Depends on team size. Consider Salesforce too"  → sentiment: Neutral, mentioned: YES
Groq:    "Top options are Salesforce, Dynamics, Rival..."  → mentioned: NO (Acme not in response)
```

Result: 75% mention rate for this prompt. The Groq gap is a real AEO problem: buyers using Groq-powered tools won't see Acme. The Gemini negative sentiment is a real content problem: Google's search index has negative recent reviews.

Both are actionable insights, and neither can be seen if you reconcile into a "consensus."

---

## Q6: How do you handle rate limits from a provider like OpenAI when running many analyses concurrently?

**Short answer**: Three layers: (1) prevention via concurrency limits (max 2 in-flight per provider), (2) recovery via exponential backoff retries on 429s, and (3) fallback to alternative providers for structural tasks if primary is exhausted. Known gap: the retry logic doesn't read `Retry-After` headers and doesn't implement a proactive token-bucket rate limiter.

**Full detail**: See [`06-rate-limits-and-retries.md`](./06-rate-limits-and-retries.md).

**The three-layer defense**:
```
Prevention:
  PER_PROVIDER_CONCURRENCY=2    → max 2 calls per provider at once
  SEARCH_CONCURRENCY=4          → max 4 total across all providers

Recovery (per call):
  withRetries(): 1s → 2s → 4s exponential backoff
  On final failure: store error row, continue

Recovery (structural tasks):
  completePreferringGemini(): Gemini → Groq → OpenAI → Claude
  One provider rate-limited? Automatic failover, no human needed

Recovery (catastrophic):
  BullMQ job retry: 2s → 4s → 8s exponential backoff
  Up to MAX_RETRIES+1 total job attempts
```

**Known gap**: OpenAI returns `Retry-After: 20` in 429 headers. The current code ignores this and retries after 1s (which will fail again), burning retry budget. Parsing `Retry-After` would improve success rates under load.

---

## Q7: What's your retry strategy for a failed LLM call — exponential backoff, fixed retries, or no retry?

**Short answer**: Exponential backoff. `withRetries()` applies `delay = min(1000 × 2^attempt, 8000)ms` between attempts. Default 3 total attempts (configurable via `MAX_RETRIES`). Search failures become error rows (not job failures). Structural failures trigger the fallback provider chain. Job-level failures trigger BullMQ retries with their own 2s/4s/8s backoff.

**Full detail**: See [`06-rate-limits-and-retries.md`](./06-rate-limits-and-retries.md).

**Retry schedule**:
```
Call-level (withRetries):
  Attempt 1 → fail → wait 1s
  Attempt 2 → fail → wait 2s
  Attempt 3 → fail → throw (or store error for search calls)

Job-level (BullMQ, for catastrophic failures):
  Job attempt 1 → fail → wait 2s
  Job attempt 2 → fail → wait 4s
  Job attempt 3 → fail → FAILED status set
```

The two levels are independent. A call that exhausts its 3 attempts doesn't immediately fail the job — the job continues with that response missing.

---

## Q8: How is job status tracked — polling, webhooks, or something else — and where is that state stored?

**Short answer**: HTTP polling from the browser, every 2 seconds. State lives entirely in PostgreSQL (`AnalysisJob.status`, `progress`, `progressMessage`). The worker writes progress to the DB at every pipeline step. Redis (BullMQ) is never queried for status — it's only used for queue management.

**Full detail**: See [`07-job-status-tracking.md`](./07-job-status-tracking.md).

**Why polling instead of WebSockets**:
- Serverless platforms (Vercel) have no persistent process to hold a WebSocket connection
- Polling is stateless — browser closing and reopening picks up exactly where it left off
- 2-second polling feels near-real-time for a 60–90s task
- No reconnection logic, no event replay, no stale state

**Progress granularity**: Within Step 3 (search) and Step 4 (extraction), progress updates fire after every individual LLM call. A 48-call search step shows "Searching AI providers (1/48)" through "(48/48)" with smooth 2-second increments.

---

## Q9: How do buyer-intent prompts get generated or configured — are they templated, user-defined, or dynamic?

**Short answer**: Fully dynamic and AI-generated. An LLM (Gemini preferred) first builds a company context profile (industry, products, audience, use cases, keywords) from the user's inputs, then generates `N` prompts per configured category using that context. Users cannot write or edit prompts — this eliminates selection bias and ensures cross-company comparability.

**Full detail**: See [`08-prompt-generation.md`](./08-prompt-generation.md).

**Two-step process**:
```
Step 1 — Company Context (LLM):
  inputs:  company name, website, description, competitors
  output:  { industry, products, audience, useCases, keywords }

Step 2 — Prompt Generation (LLM, using context):
  categories: Comparison, Buying, Pricing, Reviews, Features, Alternatives
  output:  12 buyer-intent queries tailored to the specific company

Example outputs for a CRM company:
  "What's the best free CRM for a 10-person sales team?"         (Buying)
  "Compare Acme Corp vs HubSpot for B2B pipeline management"     (Comparison)
  "Does Acme Corp support automated lead scoring?"               (Features)
  "What are the best alternatives to Acme Corp?"                 (Alternatives)
```

---

## Q10: How do you benchmark a brand against its competitors — what's the actual scoring/ranking logic?

**Short answer**: Share of voice is the primary competitive metric — it's `company mentions / total brand mentions × 100` across all extractions. The ranking hero sorts all brands by this percentage. The composite Visibility Score is a weighted sum: mention rate (35%) + share of voice (25%) + recommendation rate (25%) + citation rate (10%) + ranking score (5%).

**Full detail**: See [`09-scoring-and-ranking.md`](./09-scoring-and-ranking.md).

**The five metrics and how they're computed**:
```
Mention Rate       = prompts with ≥1 provider mentioning company / total prompts × 100
Share of Voice     = company mentions / all brand mentions × 100
Citation Rate      = company mentions with citations / company mentions × 100
Recommendation Rate= responses where company mentioned AND (Positive OR rank≤3) / total × 100
Avg Ranking        = mean ranking position across all ranked list appearances

Visibility Score   = mentionRate×0.35 + shareOfVoice×0.25 + recRate×0.25
                   + citationRate×0.10 + rankingScore×0.05
```

**Competitor benchmark** = `competitorShare` JSON: `{ "Acme": 0.42, "Rival": 0.31, "Other": 0.15 }`. The UI renders this as a horizontal bar chart sorted by percentage.

---

## Q11: What would break first if you had to process 10,000 analyses per hour instead of the current volume?

**Short answer**: Provider rate limits break first (you'd need ~133 LLM calls/second, 8–160× most provider limits). Then Postgres connection pool limits with 40+ concurrent workers. Then Redis throughput on Upstash free tier. Then extraction cost becomes the dominant spend item at ~$1,700/day just for extraction calls.

**Full detail**: See [`10-scaling-bottlenecks.md`](./10-scaling-bottlenecks.md).

**Failure order**:
```
~20/hour:    Provider rate limits (free tier keys)
~100/hour:   Gemini/OpenAI need enterprise agreements
~200/hour:   Postgres connection pool exhausted (40 worker limit)
~500/hour:   Redis needs upgrading; admin usage query too slow
~1,000/hour: Worker concurrency model wrong; need shared rate-limit coordinator
~10,000/hour: Everything above + extraction cost cliff + DB partitioning needed
```

**The root architectural change needed for 10k/hour**: Replace per-worker concurrency limits with a Redis-backed distributed rate limiter. Instead of "max 2 calls per provider per worker," implement "max 200 calls per minute per provider across all workers, coordinated via Redis token bucket."

---

## Summary: Current Architecture Strengths and Gaps

### Strengths

- **Durability**: BullMQ + Postgres means no analysis is ever truly lost
- **Graceful degradation**: Failed providers, failed extractions, failed recommendations — none of these fail the job. The analysis completes with fewer data points.
- **Provider abstraction**: Adding a 5th LLM provider requires implementing one interface and registering it in the manager. No changes to the pipeline.
- **Progress visibility**: Fine-grained DB-backed progress means the UI is always accurate even through crashes and restarts
- **Simple cost model**: ~$0.05–0.10 per analysis at defaults, with obvious levers (disable expensive providers, reduce prompts per category)

### Known Gaps

- **Admin has no auth**: `/admin` and `/api/admin/*` are completely open. Must be fixed before any public-facing deployment.
- **`positiveSentimentRate` smuggled into `competitorShare`**: Needs a schema migration to add a proper column.
- **Retry logic ignores `Retry-After`**: Should parse provider backoff headers instead of using a fixed schedule.
- **Extraction cost is invisible**: Admin dashboard only reports search call costs; extraction and recommendation calls are not tracked.
- **No budget caps**: Users can submit unlimited analyses with no spend limit.
- **Extraction is unoptimized**: 48 individual LLM calls for extraction could be batched into 5 calls at 10× lower cost.
