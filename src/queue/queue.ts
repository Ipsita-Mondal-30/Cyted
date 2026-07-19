import { Queue } from "bullmq";
import IORedis, { type RedisOptions } from "ioredis";
import { getConfig, redisHostForLogs } from "@/lib/config";
import { createLogger } from "@/lib/logger";

export const ANALYSIS_QUEUE_NAME = "analysis";

const log = createLogger("queue");

function redisOptionsForUrl(url: string): RedisOptions {
  const isTls = url.startsWith("rediss://");
  return {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false, // friendlier for Upstash / serverless Redis
    // Keep offline queue so commands wait until TLS handshake completes
    enableOfflineQueue: true,
    connectTimeout: 20_000,
    ...(isTls ? { tls: {} } : {}),
  };
}

/** Always create a fresh connection — BullMQ workers must not share connections. */
export function createRedisConnection(): IORedis {
  const url = getConfig().redisUrl;
  const conn = new IORedis(url, redisOptionsForUrl(url));
  conn.on("connect", () => {
    log.info("Redis connected", { host: redisHostForLogs(url) });
  });
  conn.on("error", (err) => {
    log.error("Redis connection error", err.message);
  });
  return conn;
}

let analysisQueue: Queue | null = null;

export function getAnalysisQueue(): Queue {
  if (!analysisQueue) {
    const url = getConfig().redisUrl;
    analysisQueue = new Queue(ANALYSIS_QUEUE_NAME, {
      connection: createRedisConnection(),
      defaultJobOptions: {
        attempts: getConfig().maxRetries + 1,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
    log.info("Analysis queue initialized", { host: redisHostForLogs(url) });
  }
  return analysisQueue;
}

export async function enqueueAnalysis(analysisId: string) {
  const queue = getAnalysisQueue();
  log.info("Enqueueing analysis job", { analysisId });

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

  const job = await queue.add(
    "run",
    { analysisId },
    { jobId: analysisId }
  );

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
