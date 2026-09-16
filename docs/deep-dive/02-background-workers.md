# Why Background Workers, Not Synchronous Request Handling

## The Fundamental Problem

A visibility analysis makes between 40 and 100 LLM API calls. Each call takes between 1.5 and 8 seconds depending on the provider and whether web search is involved. Even with aggressive parallelism, the wall-clock time for a full analysis run is **45–90 seconds**.

HTTP requests cannot survive that.

---

## What Would Happen if You Did It Synchronously

### Serverless (Vercel)

Vercel serverless functions have hard execution limits:
- Hobby plan: 10 seconds
- Pro plan: 300 seconds (but subject to memory/CPU limits)

A 90-second analysis on a hobby plan would time out after 10 seconds with a 504. Even on Pro, you're gambling that no single LLM call takes longer than a few minutes, which is not guaranteed — especially with Claude's web search, which can take 15+ seconds.

The deeper problem: **serverless functions are stateless**. You can't stream fine-grained progress (2%, 5%, 12%, ...) back to a polling client from a single HTTP request. You'd need WebSockets or SSE, both of which have their own timeout constraints in serverless environments.

### Traditional Long-Lived Server

Even on a persistent Node.js server (Render, Railway), handling this synchronously creates a different set of problems:

```
User A submits analysis → request thread blocks for 90 seconds
User B submits analysis → waits behind User A
User C submits analysis → waits behind User A and B
...
```

With a single-threaded async runtime like Node.js, the event loop itself isn't blocked (the LLM calls are awaited), but you're tying up server resources for each concurrent analysis. Ten simultaneous analyses means ten long-lived connections, ten sets of open sockets to four different LLM providers, and ten polling clients hammering the status endpoint.

More critically: **what happens if the server restarts mid-analysis?** The job is lost. The user has no idea what happened. The data is in an undefined state.

---

## What the Background Worker Architecture Gives You

### 1. Durability

BullMQ persists jobs in Redis. If the worker crashes, restarts, or is deployed with a new version, the job survives. BullMQ re-queues it automatically.

```
Worker crashes at Step 4 (extraction, 70%)
      │
      ▼
BullMQ detects stalled job (lockDuration: 10 min, stalledInterval: 60s)
      │
      ▼
After maxStalledCount (3) checks, marks job as failed
      │
      ▼
BullMQ re-queues with exponential backoff (2s → 4s → 8s)
      │
      ▼
Worker restarts, picks up job again
Worker deletes prior attempt data (clean slate)
Worker starts over from Step 0
```

No data is lost. The UI keeps polling. The user sees "PROCESSING" the whole time.

### 2. Decoupled Scaling

The Next.js web server and the worker are deployed as completely separate services. You can:
- Scale the web tier to handle more HTTP traffic without touching the worker
- Scale the worker tier to process more concurrent jobs without touching the web tier
- Deploy a new worker version (updated LLM prompts, better extraction logic) without any downtime to the UI

```
Web (Vercel)          →  auto-scales with traffic
Worker (Render)       →  scale by adding instances, not by touching the web layer
Redis (Upstash)       →  managed, scales automatically
```

### 3. Retry Logic Without Client Involvement

The HTTP client just gets a `jobId`. It doesn't know (or care) that the job internally failed three times before succeeding. BullMQ handles retries transparently:

```
Attempt 1 → provider rate limit hit → fail
              ↓ wait 2 seconds
Attempt 2 → Gemini quota exhausted → fail
              ↓ wait 4 seconds
Attempt 3 → all providers available → success
```

The user sees "PROCESSING" throughout. They never see a 500 error.

### 4. Progress Visibility

Because the worker writes progress to the database at each step, the UI can poll it with any client — browser tab, mobile app, a script. The progress state is in the database, not in server memory.

```
Worker writes: { progress: 65, progressMessage: "Searching AI providers (8/12)" }
Browser polls: GET /api/analysis/status/[jobId]
Browser reads: shows "65% — Searching AI providers (8/12)"
```

If the browser closes and reopens, it picks up wherever the job is.

### 5. Resource Isolation

LLM calls are memory-intensive (large response payloads) and time-intensive (blocking on network I/O). Putting them in a dedicated process keeps their resource usage from affecting web server latency.

The web server handles fast operations: auth checks (~10ms), DB reads (~5ms), form validation (~1ms). The worker handles slow operations: LLM calls (1.5–8s each). These have very different resource profiles and should not compete.

---

## The Tradeoff: Operational Complexity

The worker architecture is not free. It adds:

- **Two deployment targets**: the web app and the worker must both be deployed, share env vars, and point at the same Redis and Postgres instances
- **Redis dependency**: if Redis is down, new analyses cannot be queued (the web server returns an error on job creation)
- **Debugging complexity**: a failure in the worker is not directly visible to the user; you need structured logging (which the app has via `createLogger()`) and monitoring

But for an application where individual jobs take 45–90 seconds and involve 4 external API integrations, this is the only viable architecture.

---

## Why BullMQ Specifically

BullMQ was chosen over alternatives for these reasons:

**vs. a simple DB-backed queue (Postgres SKIP LOCKED)**:
- BullMQ provides job-level retry logic, backoff, stall detection, and a monitoring UI out of the box
- No need to write a polling loop or manage lock TTLs manually

**vs. cloud queues (SQS, Cloud Tasks)**:
- BullMQ is self-hosted on Redis — no vendor lock-in and works identically locally and in production
- Upstash Redis provides a free-tier serverless Redis that works anywhere

**vs. other Node.js queue libraries (Bull v3, agenda, bee-queue)**:
- BullMQ is the modern successor to Bull, with TypeScript-first design and active maintenance
- Built-in support for job prioritization, delayed jobs, repeatable jobs, and worker sandboxing

---

## What the Queue Actually Stores

Each BullMQ job entry in Redis contains:
```json
{
  "id": "clxyz123...",      // matches analysisId
  "name": "run",
  "data": { "analysisId": "clxyz123..." },
  "opts": {
    "attempts": 3,
    "backoff": { "type": "exponential", "delay": 2000 }
  },
  "attemptsMade": 0,
  "timestamp": 1724840000000,
  "processedOn": null,
  "finishedOn": null
}
```

The actual analysis data (company name, prompts, responses, metrics) is **never stored in Redis** — only the job ID. All analysis state lives in Postgres. Redis only stores queue metadata.
