import { Queue } from "bullmq";
import IORedis, { type RedisOptions } from "ioredis";
import { getConfig, redisHostForLogs, resolveRedisUrl } from "@/lib/config";
import {
  getActiveRedisUrl,
  isRedisQuotaError,
  withRedisFailover,
} from "@/lib/redis-endpoints";
import { createLogger } from "@/lib/logger";

export const ANALYSIS_QUEUE_NAME = "analysis";

const log = createLogger("queue");

/**
 * Parse REDIS_URL into BullMQ/ioredis connection options.
 * Upstash requires TLS (`rediss://`) — plain `redis://` causes ECONNRESET loops.
 */
export function getRedisConnectionOptions(): RedisOptions {
  const url = getActiveRedisUrl();
  const parsed = new URL(url);
  const isUpstash = parsed.hostname.includes("upstash.io");
  const useTls = parsed.protocol === "rediss:" || isUpstash;

  const opts: RedisOptions = {
    host: parsed.hostname,
    port: Number(parsed.port || (useTls ? 6379 : 6379)),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
    enableOfflineQueue: true,
    connectTimeout: 30_000,
    // TCP keepalive so Upstash / proxies don't drop idle BullMQ blocking connections
    keepAlive: 10_000,
    // Prefer IPv4 when dual-stack DNS causes flaky connects on some hosts
    family: 4,
    retryStrategy(times) {
      const delay = Math.min(times * 500, 10_000);
      if (times === 1 || times % 10 === 0) {
        log.warn("Redis reconnecting", {
          host: parsed.hostname,
          attempt: times,
          delayMs: delay,
        });
      }
      return delay;
    },
    reconnectOnError(err) {
      const msg = err.message || "";
      if (isRedisQuotaError(err)) {
        return false;
      }
      // Reconnect on common Upstash / proxy drops
      if (
        msg.includes("ECONNRESET") ||
        msg.includes("EPIPE") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("READONLY")
      ) {
        return true;
      }
      return false;
    },
  };

  if (useTls) {
    opts.tls = {};
  }

  return opts;
}

/** Dedicated IORedis instance (worker / long-lived process). */
export function createRedisConnection(): IORedis {
  const opts = getRedisConnectionOptions();
  const host = `${opts.host}:${opts.port}`;
  const conn = new IORedis(opts);

  let loggedReady = false;
  conn.on("ready", () => {
    if (!loggedReady) {
      log.info("Redis ready", { host, tls: Boolean(opts.tls) });
      loggedReady = true;
    }
  });
  conn.on("error", (err) => {
    // Avoid spamming identical errors every reconnect tick
    log.error("Redis connection error", err.message);
  });
  conn.on("close", () => {
    log.warn("Redis connection closed", { host });
  });

  return conn;
}

let analysisQueue: Queue | null = null;

function resetAnalysisQueueSingleton() {
  if (!analysisQueue) return;
  const stale = analysisQueue;
  analysisQueue = null;
  void stale.close().catch((err) => {
    log.warn("Failed to close queue during Redis failover", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export function getAnalysisQueue(): Queue {
  if (!analysisQueue) {
    // Pass options (not a shared client) so BullMQ can open its own connections
    analysisQueue = new Queue(ANALYSIS_QUEUE_NAME, {
      connection: getRedisConnectionOptions(),
      defaultJobOptions: {
        attempts: getConfig().maxRetries + 1,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
    log.info("Analysis queue initialized", {
      host: redisHostForLogs(getActiveRedisUrl()),
    });
  }
  return analysisQueue;
}

/**
 * Enqueue for serverless (Vercel): open a short-lived Queue, add job, close.
 * Avoids holding stale TLS sockets across lambda invocations.
 */
export async function enqueueAnalysis(analysisId: string) {
  const isServerless =
    Boolean(process.env.VERCEL) || process.env.QUEUE_EPHEMERAL === "1";

  if (isServerless) {
    return enqueueEphemeral(analysisId);
  }

  return enqueueWithSingleton(analysisId);
}

async function enqueueWithSingleton(analysisId: string) {
  return withRedisFailover(async () => {
    const queue = getAnalysisQueue();
    try {
      return await addJob(queue, analysisId);
    } catch (err) {
      if (isRedisQuotaError(err)) {
        resetAnalysisQueueSingleton();
      }
      throw err;
    }
  });
}

async function enqueueEphemeral(analysisId: string) {
  return withRedisFailover(async () => {
    log.info("Enqueueing via ephemeral Upstash connection (serverless)", {
      analysisId,
      host: redisHostForLogs(getActiveRedisUrl()),
    });
    const queue = new Queue(ANALYSIS_QUEUE_NAME, {
      connection: getRedisConnectionOptions(),
      defaultJobOptions: {
        attempts: getConfig().maxRetries + 1,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });

    try {
      return await addJob(queue, analysisId);
    } finally {
      await queue.close().catch((err) => {
        log.warn("Failed to close ephemeral queue", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  });
}

async function addJob(queue: Queue, analysisId: string) {
  log.info("Enqueueing analysis job", {
    analysisId,
    host: redisHostForLogs(getActiveRedisUrl()),
  });

  const existing = await queue.getJob(analysisId);
  if (existing) {
    const state = await existing.getState();
    log.warn("Job already exists in queue", { analysisId, state });
    if (state === "completed" || state === "failed") {
      await existing.remove();
      log.info("Removed stale job before re-add", { analysisId, state });
    } else {
      log.info("Job already waiting/active — skipping duplicate add", {
        analysisId,
        state,
      });
      return existing;
    }
  }

  const job = await queue.add("run", { analysisId }, { jobId: analysisId });

  const counts = await queue.getJobCounts(
    "waiting",
    "active",
    "completed",
    "failed",
    "delayed"
  );
  log.info("Job enqueued", {
    analysisId,
    bullJobId: job.id,
    queueCounts: counts,
  });

  return job;
}

// Re-export for callers that need URL resolution helpers
export { resolveRedisUrl };
