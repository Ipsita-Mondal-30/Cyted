# Job Status Tracking — How the UI Stays in Sync With the Worker

## The Design Decision: Polling over Webhooks

The system uses **HTTP polling** from the browser. The UI calls `GET /api/analysis/status/[jobId]` every 2 seconds until the job completes. This is a deliberate tradeoff against the alternatives.

---

## Why Polling, Not WebSockets

### WebSockets would require persistent connections

A WebSocket server maintains an open TCP connection per connected client. In a serverless deployment (Vercel), there's no persistent process to hold that connection — each API invocation is stateless and short-lived. A WebSocket endpoint on Vercel would require a third-party service (Pusher, Ably, Supabase Realtime) for the actual connection management.

### WebSockets would require more state management

With polling, the client is completely stateless between requests. The entire state of the UI comes from the last poll response. If the browser tab goes to sleep, is backgrounded on mobile, or the network drops for 30 seconds — the client just picks up where it left off on the next poll.

With WebSockets, you need reconnection logic, message replay (to catch events missed during disconnection), and a server-side event emitter.

### SSE (Server-Sent Events) has the same persistent connection problem on serverless

SSE is one-directional (server → client), which fits the progress use case, but it still requires a persistent HTTP connection. On Vercel, an SSE handler would have the same serverless-hostile constraint.

### Polling is simple, debuggable, and resilient

Every poll is an independent, authenticated, cacheless HTTP request. If the request fails, the error is visible and the next poll automatically retries. No reconnection logic. No event buffering. No stale state.

The 2-second interval is fast enough to feel responsive (users perceive 2-second updates as near-real-time for a task that takes 60–90 seconds) but slow enough to avoid overwhelming the database or the client.

---

## Where the State Lives

**All job state is in PostgreSQL**, specifically in `AnalysisJob`:

```sql
-- Fields polled by the UI:
id              -- immutable job identifier
status          -- QUEUED | PROCESSING | COMPLETED | FAILED
progress        -- 0-100 integer
progressMessage -- human-readable step description
error           -- set on FAILED, null otherwise
warnings        -- JSON array of soft-fail messages
companyName     -- updated after brand resolution
```

The worker writes these fields at every pipeline step. The status API reads them. Redis (BullMQ) is never queried by the status endpoint — it's only used for queue management.

This means the status is durable. If the worker crashes, the last `progress` and `progressMessage` values remain in the database. The UI continues to show "Searching AI providers (8/12)" even if the worker is down — it's not incorrect, just paused.

---

## The Polling Implementation

```typescript
// AnalysisDashboard.tsx
async function tick() {
  try {
    const s = await loadStatus(); // GET /api/analysis/status/[jobId]
    setStatus(s);
    setPollCount(n => n + 1);
    setFetchError(null);

    if (s.status === "COMPLETED" || s.status === "FAILED") {
      const r = await loadResults(); // GET /api/analysis/results/[jobId] — one time
      setResults(r);
      return; // stop polling, no more setTimeout
    }

    timer = setTimeout(tick, 2000); // schedule next poll
  } catch (err) {
    setFetchError(err.message);
    timer = setTimeout(tick, 4000); // slow down on error (4s instead of 2s)
  }
}
```

Key behaviors:
- **2-second interval** when healthy
- **4-second interval** on network/server error — backs off to reduce pressure during transient failures
- **Stops automatically** on COMPLETED or FAILED — no manual cleanup required
- **Recovers automatically** from network interruptions — the loop keeps running regardless

---

## The Status API Route

```typescript
// src/app/api/analysis/status/[jobId]/route.ts
export const dynamic = "force-dynamic"; // never cached — always hits the DB

export async function GET(request, { params }) {
  const { userId } = await requireUser(request);

  const job = await prisma.analysisJob.findUnique({
    where: { id: params.jobId },
    select: {
      id: true,
      status: true,
      progress: true,
      progressMessage: true,
      error: true,
      warnings: true,
      companyName: true,
      createdAt: true,
      completedAt: true,
      userId: true,  // for ownership check
    }
  });

  if (!job || job.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...job,
    dbHost: new URL(getConfig().databaseUrl).host, // diagnostic
    polledAt: new Date().toISOString(),             // diagnostic
  });
}
```

The `dbHost` field is included for debugging connection issues — if the UI shows an error mentioning a database host, operators can immediately see which Postgres instance the API is reading from.

---

## Progress Updates in the Worker

The worker writes progress at the start and end of each pipeline step via `updateProgress()`:

```typescript
async function updateProgress(analysisId, progress, progressMessage, job) {
  // 1. Write to Postgres — the UI will see this on the next poll
  await prismaWrite(() =>
    prisma.analysisJob.update({
      where: { id: analysisId },
      data: { progress, progressMessage },
    })
  );

  // 2. Update BullMQ job progress — for BullMQ monitoring tools (Bull Board, etc.)
  await job.updateProgress(progress);
}
```

Within Step 3 (provider search), progress is updated after **each individual LLM call** completes:

```typescript
await searchAllProviders(analysisId, prompts, async (done, total) => {
  const pct = 40 + Math.floor((done / total) * 25);
  await updateProgress(analysisId, pct, `Searching AI providers (${done}/${total})`, job);
});
```

This means the UI shows "Searching AI providers (1/48)", then "(2/48)", "(3/48)", etc. — a smooth progress bar rather than sudden jumps. The user can see that something is happening even if the step takes 40 seconds.

---

## Progress Granularity

```
Step 0: Brand resolution     → 5%  (single update)
Step 1: Company context      → 10% → 20% (start/end)
Step 2: Prompt generation    → 20% → 40% (start/end)
Step 3: Provider search      → 40% ... 65% (per-call updates)
Step 4: Extraction           → 70% ... 85% (per-call updates)
Step 5: Metrics              → 90% (single update)
Step 6: Recommendations      → 95% → 100% (start/complete)
```

The densest feedback is during Steps 3 and 4 because those are the longest-running steps and have the most parallelizable sub-tasks.

---

## What the UI Shows During Processing

```
[████████████░░░░░░░░░░░░] 65%
Searching AI providers (8/12)

⚠ Warnings (if any):
  "Brand resolution failed — using original input"
```

The progress bar is bound to `status.progress`. The message below it is `status.progressMessage`. Both update every 2 seconds.

Once the results load:
- The progress bar disappears
- The full report renders in place

---

## Public Mode (No Polling)

For public shareable reports (`/report/[jobId]`, `mode="public"`), polling is not needed — the report is only accessible once the job is `COMPLETED`. The component skips the polling loop entirely:

```typescript
if (isPublic) {
  // Load results once, no polling loop
  const r = await loadResults(); // GET /api/public/report/[jobId]
  setResults(r);
  setStatus({ status: r.status, progress: r.progress, ... });
  return;
}
```

If someone shares a link to an in-progress job, the public API returns 404 (it filters to `status = COMPLETED`). The page shows a "not found" state.

---

## Why Not Store Progress in Redis?

BullMQ does have a `job.updateProgress()` method that stores progress in Redis. The system calls this too (for BullMQ monitoring dashboards like Bull Board). But it's not the source of truth for the UI.

Storing progress in Postgres instead of Redis means:
1. The same DB that stores all analysis data also stores its status — one source of truth
2. Progress survives worker restarts (Redis is ephemeral for job data once completed)
3. Historical progress can be queried (you can ask "what was the progress of job X at 2pm?")
4. The status API doesn't need a Redis connection — it only needs Postgres
