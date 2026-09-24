# Worker Concurrency Guide

## Current Setting: `concurrency: 4`

The worker now processes **4 analysis jobs simultaneously** instead of 1 at a time.

---

## What This Means

### Throughput
- **Before**: ~48 jobs/hour (60s per job × 1 at a time)
- **After**: ~192 jobs/hour (60s per job × 4 at a time)

### Queue Behavior
- **Before**: Job 2 waits 60s for Job 1 to finish, Job 3 waits 120s, etc.
- **After**: Jobs 1-4 all start immediately, Job 5 waits ~60s

### User Experience
- Users are much less likely to see "Analysis is taking longer than expected" warnings
- Multiple simultaneous submissions no longer block each other

---

## What to Watch For

### 1. Provider Rate Limit Errors

**Symptom**: Lots of `Response` rows with `error: "Rate limit exceeded"` in the database

**Check via**:
```
GET /api/admin/usage
→ Look at "successRate" per provider
→ If < 80%, you're hitting limits
```

**Solution**:
- Reduce concurrency back to 2 or 3
- Upgrade to paid provider tiers (higher RPM limits)
- Reduce `PROMPTS_PER_CATEGORY` from 2 to 1 (fewer calls per job)

### 2. Database Connection Pool Exhaustion

**Symptom**: Jobs fail with `pool_timeout` or `connection refused` errors in worker logs

**Check via**: Render logs for strings like:
```
pool_timeout
ECONNREFUSED
remaining connection slots
```

**Solution**:
- The `prismaWrite()` semaphore already limits to 2 parallel writes
- If this happens, reduce concurrency to 2
- Or increase Postgres connection limit (requires Supabase plan upgrade)

### 3. Redis Quota Exceeded

**Symptom**: Worker logs show:
```
Redis failover: max_requests_limit exceeded
Failing over to next Redis endpoint
```

**What happens**:
- The system automatically tries the next Upstash endpoint (you have 3)
- If all 3 are exhausted, new jobs fail to enqueue

**Check via**:
```bash
# In Upstash dashboard for each endpoint:
# Commands Used / Daily Limit
```

**Solution**:
- Upgrade one or more Upstash instances to paid tier ($20/mo = 1M commands/day)
- Or reduce concurrency to 2

### 4. Memory Issues (Render Worker)

**Symptom**: Worker crashes with OOM (Out Of Memory) errors, or Render shows high memory usage spikes

**Check via**: Render dashboard → your worker service → Metrics tab → Memory usage

**Each concurrent job uses**:
- ~100MB base
- ~2MB per Response row (48 responses = ~100MB)
- Peak during extraction: ~200MB per job

**4 concurrent jobs = ~800MB peak**

**Solution**:
- If on Render free tier (512MB): upgrade to Starter ($7/mo, 512MB) or Standard ($25/mo, 2GB)
- Or reduce concurrency to 2

---

## Monitoring Commands

### Check current queue depth
```bash
redis-cli --tls -u "rediss://..." LLEN bull:analysis:wait
# Returns number of jobs waiting in queue
# Should be 0 or low single digits most of the time
```

### Check active jobs
```bash
redis-cli --tls -u "rediss://..." LLEN bull:analysis:active
# Returns number currently processing
# Should be 0-4 (your concurrency limit)
```

### Check failed jobs
```bash
redis-cli --tls -u "rediss://..." LLEN bull:analysis:failed
# Should be 0 in healthy state
```

### Check recent job IDs
```bash
redis-cli --tls -u "rediss://..." LRANGE bull:analysis:wait 0 -1
# Shows all waiting job IDs
```

---

## When to Scale Up Further

Increase concurrency to 6-8 when:
- ✅ Queue depth consistently > 5
- ✅ You're on paid provider tiers with high RPM limits
- ✅ Render worker is on Standard plan (2GB RAM)
- ✅ No rate limit errors in admin dashboard
- ✅ Memory usage < 70% peak on Render

---

## When to Scale Down

Reduce concurrency to 2 if:
- ❌ Provider success rate drops below 80%
- ❌ Worker crashes with OOM errors
- ❌ Database connection pool timeout errors
- ❌ Redis failover messages appearing frequently

---

## Cost Implications

**With concurrency = 4**:
- 4× more LLM calls per minute during peak usage
- If all 4 jobs hit provider rate limits simultaneously, retry costs multiply
- Monitor via `/api/admin/usage` — "Total estimated cost" should scale linearly, not exponentially

**Healthy pattern**: Cost per job stays constant (~$0.05-0.10), total daily cost scales with job volume

**Unhealthy pattern**: Cost per job increases (more retries due to rate limits)

---

## Rollback

To revert to `concurrency: 1`:

```typescript
// src/workers/analysis.worker.ts
const worker = new Worker<AnalysisJobData>(
  ANALYSIS_QUEUE_NAME,
  processAnalysis,
  {
    connection: redisOpts,
    concurrency: 1,  // <-- change back to 1
    lockDuration: 10 * 60 * 1000,
    stalledInterval: 60 * 1000,
    maxStalledCount: 3,
  }
);
```

Then redeploy the worker service on Render. Changes take effect immediately for new jobs.
