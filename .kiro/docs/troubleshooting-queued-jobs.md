# Troubleshooting Queued Jobs

## Changes Made

### 1. Improved "Still Queued" Warning

**Before**: Warning appeared after 3 polls (~6 seconds) with technical details about DATABASE_URL.

**After**: 
- Warning appears after 10 polls (~20 seconds) to reduce false alarms
- User-friendly message: "Analysis is taking longer than expected. The worker may be processing other jobs or starting up."
- Removed technical jargon (no mention of Render, Vercel, DATABASE_URL)

### 2. Added "Check Status Again" Button

When the warning appears, users now see a button that:
- Resets the poll count
- Clears any fetch errors
- Triggers the useEffect to restart polling fresh
- Shows "Checking..." state while retrying

This is useful when:
- The worker was temporarily down but is now back up
- Redis connection was momentarily lost
- The user returns to the page after hours/days

---

## Why Jobs Get Stuck in QUEUED

### Root Causes

1. **Worker not running**
   - The Render worker service is down
   - The worker crashed and didn't restart
   - The worker is stuck in a build/deploy state

2. **Redis connection issues**
   - All 3 Upstash endpoints hit their quota
   - Network issues between worker and Redis
   - Redis authentication failed

3. **Database connection mismatch**
   - The worker is connected to a different Postgres instance than the web app
   - Rare, but possible if `DATABASE_URL` env vars diverged

4. **Worker concurrency = 1**
   - The worker processes one job at a time
   - If a previous job is stuck (hung LLM call, infinite retry loop), new jobs queue behind it

---

## Multi-User Scenarios

### Question: "If I'm using Cyted for my analysis and someone else uses it as well, will they get this error?"

**Short answer**: No, not if the worker is running. Jobs are processed one at a time, so the second user's job will just wait in the queue. They'll see "QUEUED" status, but it will move to "PROCESSING" once your job finishes.

**Detailed scenarios**:

#### Scenario 1: Worker is healthy, one job at a time
```
t=0s:   You submit job A    → status: QUEUED
t=1s:   Worker picks up A   → status: PROCESSING
t=5s:   User 2 submits job B → status: QUEUED (waiting behind A)
t=60s:  Job A completes     → status: COMPLETED
t=61s:  Worker picks up B   → status: PROCESSING
t=120s: Job B completes     → status: COMPLETED
```

User 2 sees:
- First 60 seconds: "QUEUED" (progress: 0%, no warning yet)
- At 20 seconds queued: warning appears with "Check Status Again" button
- After 60 seconds: "PROCESSING" starts, progress begins incrementing

**This is expected behavior**. The warning after 20 seconds helps User 2 understand the job hasn't been forgotten — it's just waiting.

#### Scenario 2: Worker is down
```
t=0s:   You submit job A    → status: QUEUED
t=20s:  Warning appears: "taking longer than expected"
        Click "Check Status Again" → still QUEUED
t=5m:   Admin restarts worker
t=5m1s: Worker picks up A   → status: PROCESSING
```

The "Check Status Again" button is most useful here. If the user suspects the worker might have restarted (e.g. after reaching out to support), they can manually re-check instead of waiting for the next 2-second poll cycle.

#### Scenario 3: Multiple users, worker running
```
t=0s:   User A submits job  → QUEUED → picked up immediately → PROCESSING
t=10s:  User B submits job  → QUEUED (waiting behind A)
t=15s:  User C submits job  → QUEUED (waiting behind A and B)
t=20s:  User B sees warning (has been queued 10+ polls = 20s)
t=30s:  User C sees warning (has been queued 10+ polls = 20s)
t=60s:  A completes → B picked up → B status: PROCESSING
t=120s: B completes → C picked up → C status: PROCESSING
```

**Key point**: The warning doesn't mean something is broken. It means "your job is waiting in line." With worker `concurrency: 1`, this is expected when multiple users submit simultaneously.

---

## When to Scale Up

If users regularly see the "taking longer than expected" warning and jobs are legitimately queued (not stuck), you need more workers:

```
Current capacity:  1 worker × 1 job at a time × ~75s per job = ~48 jobs/hour max
```

To handle 100 jobs/hour: deploy 2–3 worker instances pointing at the same Redis queue. BullMQ automatically distributes jobs across workers.

---

## How to Check if Worker is Running

### From the Render dashboard:
1. Go to your worker service
2. Check "Status" — should show "Live" with a green dot
3. Check "Logs" — should see recent `"Picked up job"` entries

### From the app (as admin):
1. Go to `/admin`
2. Check "Recent Analyses" table
3. Look for jobs with `status: PROCESSING` — if any exist, worker is alive
4. If all recent jobs are `QUEUED` for >5 minutes, worker is likely down

### Via Redis CLI:
```bash
redis-cli --tls -u "rediss://..." LLEN bull:analysis:wait
```
If this returns a growing number over time, jobs are queuing up (worker not consuming them).

---

## Recommended Actions for Users Seeing the Warning

1. **Wait 1–2 minutes first** — the job might just be waiting behind another user's job
2. **Click "Check Status Again"** — this is safe and just resets the polling state
3. **If still QUEUED after 5+ minutes** — contact support or check `/admin` to see if other jobs are processing
4. **Don't submit duplicate jobs** — submitting the same analysis again won't help (BullMQ prevents duplicate job IDs anyway)
