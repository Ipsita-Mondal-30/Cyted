import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getConfig } from "@/lib/config";

export const ANALYSIS_QUEUE_NAME = "analysis";

let connection: IORedis | null = null;
let analysisQueue: Queue | null = null;

export function getRedisConnection(): IORedis {
  if (!connection) {
    connection = new IORedis(getConfig().redisUrl, {
      maxRetriesPerRequest: null,
    });
  }
  return connection;
}

export function getAnalysisQueue(): Queue {
  if (!analysisQueue) {
    analysisQueue = new Queue(ANALYSIS_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: getConfig().maxRetries + 1,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
  }
  return analysisQueue;
}

export async function enqueueAnalysis(analysisId: string) {
  const queue = getAnalysisQueue();
  await queue.add(
    "run",
    { analysisId },
    { jobId: analysisId }
  );
}
