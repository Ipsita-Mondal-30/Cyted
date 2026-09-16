# Worker & Queue

The analysis pipeline runs entirely in a **separate background worker process**, not inside the Next.js app. The two processes communicate via a **Redis-backed BullMQ job queue**.

---

## Why a Separate Worker?

A full analysis run makes 40–100+ LLM API calls and takes 30–120 seconds. This cannot run inside a Next.js API route for several reasons:
- Vercel serverless functions have a maximum execution time (~60s on hobby, 300s on pro)
- HTTP requests would time out
- There's no way to stream fine-grained progress back to a polling client from a single request

The solution: the API route creates a DB record and enqueues a BullMQ job immediately (< 100ms), returning `{ jobId }`. The worker processes the job asynchronously. The browser polls `/api/analysis/status/[jobId]` every 2 seconds to track progress.

---

## Queue Architecture

**File**: `src/queue/queue.ts`

```
Next.js API (producer)              Worker process (consumer)
        │                                     │
        │  queue.add("run", { analysisId })   │
        │─────────────────────────────────────►│
        │           Redis (BullMQ)             │
        │◄─────────────────────────────────────│
        │                            worker.on("completed")
        │                            worker.on("failed")
```

**Queue name**: `"analysis"`  
**Job name**: `"run"`  
**Job data**: `{ analysisId: string }`

### Redis Connection

BullMQ uses `ioredis` as its Redis client. The connection is configured via `getRedisConnectionOptions()`:

```typescript
{
  // Parsed from REDIS_URL or constructed from UPSTASH_REDIS_REST_URL + TOKEN
  host, port, password, tls,

  // Upstash-specific settings to prevent idle connection drops
  keepAlive: 10_000,    // TCP keepalive every 10 seconds
  family: 4,            // Force IPv4 (Upstash requirement)
  enableReadyCheck: false,  // Skip ready check for serverless
  maxRetriesPerRequest: null,  // Required for BullMQ
  connectTimeout: 30_000,
}
```

### Serverless vs Long-lived Queue

The API route handles two deployment scenarios differently:

**Serverless (Vercel)**: Each lambda invocation creates a new Queue instance, adds the job, then explicitly closes the connection. This avoids stale TLS socket state across cold starts.

**Long-lived (Render, Railway, local)**: A singleton Queue instance is reused across requests. The connection stays open, which is more efficient.

Detection is via `process.env.VERCEL === "1"`.

---

## Worker Process

**File**: `src/workers/analysis.worker.ts`  
**Start command**: `npm run worker`  
**Watch mode**: `npm run dev:worker` (tsx --watch)

The worker is a standard Node.js process. It should be deployed as a separate service alongside the Next.js app. Both must share the same `DATABASE_URL` and `REDIS_URL`.

### BullMQ Worker Configuration

```typescript
new Worker("analysis", processAnalysis, {
  connection: getRedisConnectionOptions(),
  concurrency: 1,           // one job at a time per worker instance
  lockDuration: 600_000,    // 10 minutes — prevents stale job detection during long LLM calls
  stalledInterval: 60_000,  // check for stalled jobs every 60s
  maxStalledCount: 3,       // mark as failed after 3 stall checks
})
```

**Concurrency is 1**: Each worker handles one analysis at a time. This is intentional — LLM calls already fan out in parallel inside the job. Running multiple jobs simultaneously on one worker would risk hitting rate limits on all providers simultaneously. Scale horizontally by adding more worker instances.

**Lock duration is 10 minutes**: BullMQ requires the worker to renew the job lock periodically to prove it's still alive. 10 minutes is generous to accommodate slow LLM responses without triggering false stall detection.

### Default Job Options

```typescript
{
  attempts: MAX_RETRIES + 1,   // default: 3 total attempts
  backoff: {
    type: "exponential",
    delay: 2000                // 2s → 4s → 8s between attempts
  }
}
```

### Error Handling

The worker registers global handlers to prevent silent crashes:

```typescript
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception", { error: err.message });
  // worker continues — BullMQ catches the error at the job level
});

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection", { reason });
});
```

---

## Job Processing Flow

`processAnalysis(job)` in `analysis.worker.ts` is the BullMQ job handler. It orchestrates the entire 6-step pipeline.

### Before Each Job Starts

1. Calls `ensurePrismaConnected()` — runs `SELECT 1` to verify DB connectivity, reconnects if needed
2. Loads the `AnalysisJob` record from the database
3. Reads `SystemConfig.enabledProviders` to determine which providers are active
4. **Cleans up any prior attempt data** (in a transaction):
   ```
   DELETE ExtractedResult WHERE response.analysisId = X
   DELETE Response WHERE analysisId = X
   DELETE Prompt WHERE analysisId = X
   DELETE Metrics WHERE analysisId = X
   DELETE Recommendation WHERE analysisId = X
   ```
   This ensures retries don't accumulate duplicate rows.

### Progress Updates

The `updateProgress()` helper is called between steps:

```typescript
async function updateProgress(analysisId, progress, progressMessage, job) {
  // 1. Write to DB (polled by the UI)
  await prismaWrite(() =>
    prisma.analysisJob.update({
      where: { id: analysisId },
      data: { progress, progressMessage }
    })
  );
  // 2. Update BullMQ job progress (for monitoring tools)
  await job.updateProgress(progress);
}
```

### Pipeline Steps and Progress

| Step | Progress range | Message example |
|---|---|---|
| Start | 5% | "Resolving brands & discovering competitors" |
| Brand resolution | 5% | (runs) |
| Company context | 10–20% | "Creating company context" |
| Prompt generation | 20–40% | "Generating prompts" |
| Provider search | 40–65% | "Searching AI providers (4/12)" |
| Extraction | 70–85% | "Extracting structured results (8/48)" |
| Metrics | 90% | "Calculating metrics" |
| Recommendations | 95–100% | "Generating recommendations" |

### Job Completion

On success:
```typescript
await prisma.analysisJob.update({
  where: { id: analysisId },
  data: {
    status: "COMPLETED",
    progress: 100,
    progressMessage: "Done",
    completedAt: new Date(),
    warnings: finalWarnings  // any soft-fail messages collected during the run
  }
});
```

On failure (the outer try/catch):
```typescript
await prisma.analysisJob.update({
  where: { id: analysisId },
  data: {
    status: "FAILED",
    error: err.message
  }
});
throw err; // re-throw so BullMQ knows to retry
```

---

## Database Resilience (`prismaWrite`)

**File**: `src/lib/db.ts`

All database writes in the worker go through `prismaWrite()`, a semaphore-limited, retry-wrapped wrapper:

```typescript
const MAX_PARALLEL_WRITES = 2;

async function prismaWrite<T>(fn: () => Promise<T>): Promise<T> {
  // Semaphore: at most 2 concurrent writes (prevents connection pool exhaustion)
  await semaphore.acquire();
  try {
    return await withRetries(fn, {
      retries: 4,
      onRetry: async () => {
        // Reconnect Prisma on connection errors
        await prisma.$disconnect();
        await prisma.$connect();
      }
    });
  } finally {
    semaphore.release();
  }
}
```

This prevents DB connection stampede when many parallel LLM results arrive simultaneously and all try to write at once.

`ensurePrismaConnected()` runs before each job:
```typescript
async function ensurePrismaConnected() {
  await prisma.$queryRaw`SELECT 1`;
  // If this throws, it will attempt to reconnect via Prisma's built-in logic
}
```

### Connection Pool Settings

The app automatically appends pool parameters to `DATABASE_URL`:
```
?connection_limit=5&pool_timeout=20
```

This prevents the worker from opening more than 5 connections to Supabase's transaction pooler (port 6543), which has per-client connection limits.

---

## Concurrency Controls

The worker uses two layers of concurrency control for the LLM fan-out steps:

### Search Step (Step 3)

```
prompts × providers all kick off together, but:

Per-provider semaphore: max perProviderConcurrency (default: 2) in-flight calls per provider
Search semaphore:       max searchConcurrency (default: 4) total in-flight calls

Example with 12 prompts × 4 providers = 48 calls:
  All 4 providers run in parallel (Promise.all)
  Each provider runs up to 2 prompts at a time (perProviderConcurrency)
  Total in-flight capped at 4 (searchConcurrency)
```

### Extraction Step (Step 4)

```
All successful responses processed with:
  mapWithConcurrency(responses, extractConcurrency)
  (default: min(CONCURRENT_REQUESTS, 3) = 3 concurrent extraction calls)
```

These settings prevent hitting provider rate limits and keep DB write pressure manageable. They're tunable via environment variables — see `configuration.md`.

---

## Deployment Notes

### Local Development

```bash
# Terminal 1: Next.js dev server
npm run dev

# Terminal 2: Worker with hot reload
npm run dev:worker
```

Both must be running. The app enqueues jobs; the worker processes them.

### Production on Vercel + Render

```
Vercel (web)               Render (worker)
┌─────────────────┐        ┌──────────────────────┐
│  next start     │        │  npm run worker       │
│  PORT 3000      │        │  (long-running Node)  │
└─────────────────┘        └──────────────────────┘
         │                           │
         └──────────┬────────────────┘
                    │
         ┌──────────▼──────────┐    ┌──────────────────┐
         │  Supabase (Postgres)│    │  Upstash (Redis)  │
         └─────────────────────┘    └──────────────────┘
```

The worker service on Render should:
- Use `npm run worker` as the start command
- Share all env vars with the Vercel deployment
- Be set to never sleep (Render Background Worker service type, not a Web Service)

### Scaling

To handle more concurrent analyses, run multiple worker instances pointing at the same Redis queue. Each will process one job at a time, providing horizontal scaling. BullMQ handles job distribution automatically.
