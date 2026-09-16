# What Would Break First at 10,000 Analyses Per Hour

## Current Capacity Baseline

At default settings, one analysis takes approximately 60–90 seconds of worker time. With worker `concurrency: 1`, a single worker instance can process roughly:

```
3600 seconds / 75 seconds avg = ~48 analyses per hour per worker
```

At 10,000 analyses per hour, you need roughly 208 worker instances running simultaneously. Here's everything that breaks before you get there.

---

## Bottleneck 1: Provider Rate Limits (Breaks First)

**Breaks at: ~5–20 analyses/hour on free tiers, ~100–500/hour on paid tiers**

This is the absolute first wall you hit.

Each analysis fires ~48 search calls. At 10,000 analyses/hour:
```
10,000 × 48 search calls / 3600 seconds = 133 LLM API calls per second
```

Rate limits by provider:
| Provider | Limit (typical paid) | What you get at 133 req/s |
|---|---|---|
| OpenAI | 500 RPM = 8.3 req/s | 16× over limit |
| Gemini | 1,000 RPM = 16.6 req/s | 8× over limit |
| Claude | 50–200 RPM = 0.8–3.3 req/s | 40–160× over limit |
| Groq | 30–300 RPM = 0.5–5 req/s | 26–260× over limit |

At scale, you need to move to enterprise agreements with much higher rate limits, and implement a proper per-provider rate limiter in the search service. The current `withRetries()` exponential backoff is not sufficient — it's a recovery mechanism, not a preventive one.

**What needs to change**:
- Token bucket rate limiter per provider in `search.service.ts`
- Track rolling 60-second request counts
- Queue excess requests rather than sending them (and getting 429s that consume retry budget)

---

## Bottleneck 2: Postgres Connection Pool (Breaks Second)

**Breaks at: ~20–50 concurrent workers**

The connection pool is configured for:
```
connection_limit=5  (per app instance, transaction pooler)
```

Supabase's transaction pooler (PgBouncer) has an overall connection limit based on the plan (typically 60–200 connections on paid plans). With each worker using up to 5 connections, you can run at most:

```
200 Supabase connections / 5 per worker = 40 worker instances max
```

Beyond that, new DB queries start getting `pool_timeout` errors (currently 20 seconds).

**What needs to change**:
- Increase `connection_limit` per instance carefully (don't exceed Supabase's total)
- Switch from the transaction pooler (PgBouncer) to direct Postgres connections for the worker, which is better suited for long-running processes
- Move off Supabase's managed Postgres to a dedicated RDS/Aurora instance with configurable `max_connections`
- Consider read replicas — status polling could hit a read replica instead of primary

---

## Bottleneck 3: Redis Queue Throughput (Breaks at High Scale)

**Breaks at: ~1,000+ jobs/hour**

BullMQ uses Redis for queue management. Upstash's free tier allows 10,000 commands/day. Each BullMQ job creates ~10–20 Redis commands (add, process, update, complete, cleanup). At 10,000 analyses/hour:

```
10,000 jobs × 15 commands = 150,000 Redis commands/hour = 3.6M/day
```

This blows past the free tier immediately and requires Upstash Pro ($20–$40/month) or a dedicated Redis instance.

More importantly, BullMQ uses polling to detect stalled jobs (by default every 5 seconds). With thousands of jobs in the queue, stall detection becomes a significant Redis load source.

**What needs to change**:
- Upgrade to Upstash Pro or dedicated Redis
- Increase `stalledInterval` from 60s to 300s for lower-priority queues
- Consider sharding across multiple queues (e.g. one queue per provider) for better fan-out

---

## Bottleneck 4: The Extraction LLM Budget

**Breaks at: high scale creates an invisible cost cliff**

The extraction pass (Step 4) makes one LLM call per successful `Response` row. At 48 responses per analysis:
```
10,000 analyses × 48 extraction calls = 480,000 LLM calls/hour
```

These calls go through `completePreferringGemini()` which prefers Gemini Flash (cheap: ~$0.075/1M input tokens). But 480,000 calls × average 2,000 tokens input = 960M tokens/hour. At $0.075/1M:

```
960M tokens / 1M × $0.075 = $72/hour just for extraction
= $1,728/day
```

And that's only extraction. Add search calls and recommendation calls, and the total is significantly higher.

**What needs to change**:
- Batch extraction: instead of one LLM call per response, group multiple responses into a single prompt and extract all in one call. A single Gemini call can handle 10+ extractions simultaneously with a structured prompt.
- Reduce `PROMPTS_PER_CATEGORY` at scale to decrease call count
- Cache extraction results by response content hash — identical responses get the same extraction

---

## Bottleneck 5: The Worker Concurrency Model

**Currently limited to: 48 analyses/hour per worker instance**

With `concurrency: 1`, each worker processes one job at a time. The reasoning (avoid provider rate limits) breaks down at scale because you have hundreds of workers all hitting the same providers simultaneously anyway.

At 208 worker instances:
```
208 workers × 2 concurrent provider calls × 4 providers = 1,664 simultaneous LLM calls
```

This is far more than any provider's rate limit.

**What needs to change**:
- The concurrency model needs to flip: fewer worker instances but with higher concurrency and a shared rate-limit coordinator
- Implement a Redis-backed rate limiter shared across all workers: before each LLM call, acquire a token from a per-provider token bucket stored in Redis
- Worker `concurrency` can then safely increase to 5–10 jobs simultaneously per instance

---

## Bottleneck 6: The Database Schema at Query Scale

**Breaks at: ~100k analyses in the DB**

The `Response` table grows at 48 rows per analysis. At 10,000 analyses/hour:
```
10,000 × 48 = 480,000 Response rows/hour
= 11.5M rows/day
= 4.2B rows/year
```

The `ExtractedResult` table grows at the same rate. This is a time-series data problem — the current relational schema (no partitioning, no archival strategy) will hit query performance issues as the table grows.

Current indexes:
```sql
@@index([analysisId])  -- on Response and Prompt
@@index([status])      -- on AnalysisJob
@@index([userId])      -- on AnalysisJob
```

These handle the current access patterns (fetch by analysisId) but won't scale to admin queries that scan across all analyses.

**What needs to change**:
- Partition `Response` and `ExtractedResult` by `createdAt` (monthly partitions)
- Archive old analysis data to cold storage (S3 + Parquet)
- Move the admin usage aggregation to a pre-computed summary table updated incrementally rather than scanning all rows on every request

---

## Bottleneck 7: The Admin Cost Aggregation Query

**Breaks at: ~10k analyses in the DB (already)**

`GET /api/admin/usage` calls `loadAdminUsage()` which scans **all** `Response` rows in the database to compute totals:

```typescript
const allResponses = await prisma.response.findMany({
  select: { provider, model, rawResponse, latencyMs, error, createdAt }
});
// Then aggregates in-process
```

At 10,000 analyses × 48 responses = 480,000 rows, this query will take seconds and consume significant DB CPU. At 1M rows, it will time out.

**What needs to change** (easy fix, should happen before scale):
- Move to `prisma.response.groupBy()` with `_count` and `_avg` instead of loading all rows
- Add a `tokenEstimate` and `costEstimate` column computed at write time rather than at query time
- Add a pre-aggregated `ProviderUsageSummary` table updated by a background job

---

## The Honest Scale Assessment

| Load | What Breaks |
|---|---|
| 10 analyses/hour | Nothing — works fine |
| 50 analyses/hour | Provider rate limits on free/tier-1 keys |
| 100 analyses/hour | Gemini and OpenAI need enterprise agreements |
| 200 analyses/hour | Postgres connection pool at its limit |
| 500 analyses/hour | Redis needs upgrading; admin usage query slows |
| 1,000 analyses/hour | Worker concurrency model is wrong; need rate-limit coordinator |
| 10,000 analyses/hour | Everything above, plus extraction cost cliff, DB partitioning needed |

The architecture is correct for the current scale. It will need significant changes — specifically around rate-limit coordination, extraction batching, and DB schema evolution — before reaching thousands of analyses per hour.
