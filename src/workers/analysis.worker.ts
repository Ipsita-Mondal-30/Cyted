import { Job, Worker } from "bullmq";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { extractFromResponses } from "@/lib/services/extraction.service";
import { calculateAndStoreMetrics } from "@/lib/services/metrics.service";
import {
  buildCompanyContext,
  generateAndStorePrompts,
} from "@/lib/services/prompt.service";
import { generateAndStoreRecommendations } from "@/lib/services/recommendation.service";
import { searchAllProviders } from "@/lib/services/search.service";
import { ANALYSIS_QUEUE_NAME, getRedisConnection } from "@/queue/queue";

type AnalysisJobData = { analysisId: string };

async function updateProgress(
  analysisId: string,
  progress: number,
  progressMessage: string,
  job?: Job
) {
  await prisma.analysisJob.update({
    where: { id: analysisId },
    data: { progress, progressMessage },
  });
  if (job) {
    await job.updateProgress(progress);
  }
}

async function processAnalysis(job: Job<AnalysisJobData>) {
  const { analysisId } = job.data;
  const analysis = await prisma.analysisJob.findUnique({
    where: { id: analysisId },
  });

  if (!analysis) {
    throw new Error(`Analysis ${analysisId} not found`);
  }

  const competitors = (analysis.competitors as string[]) || [];

  try {
    await prisma.analysisJob.update({
      where: { id: analysisId },
      data: {
        status: "PROCESSING",
        progress: 5,
        progressMessage: "Creating company context",
        error: null,
      },
    });
    await job.updateProgress(5);

    const context = await buildCompanyContext({
      companyName: analysis.companyName,
      website: analysis.website,
      description: analysis.description,
      competitors,
    });

    await prisma.analysisJob.update({
      where: { id: analysisId },
      data: { companyContext: context },
    });

    await updateProgress(analysisId, 20, "Generating prompts", job);
    await generateAndStorePrompts(analysisId, analysis.companyName, context);

    const prompts = await prisma.prompt.findMany({
      where: { analysisId },
      select: { id: true, prompt: true },
    });

    if (prompts.length === 0) {
      throw new Error("No prompts were generated");
    }

    await updateProgress(analysisId, 40, "Searching AI providers", job);
    await searchAllProviders(analysisId, prompts, async (done, total) => {
      const pct = 40 + Math.floor((done / total) * 25);
      await updateProgress(
        analysisId,
        pct,
        `Searching AI providers (${done}/${total})`,
        job
      );
    });

    await updateProgress(analysisId, 70, "Extracting structured results", job);
    await extractFromResponses(
      analysisId,
      analysis.companyName,
      competitors,
      async (done, total) => {
        const pct = 70 + Math.floor((done / Math.max(total, 1)) * 15);
        await updateProgress(
          analysisId,
          pct,
          `Extracting structured results (${done}/${total})`,
          job
        );
      }
    );

    await updateProgress(analysisId, 90, "Calculating metrics", job);
    await calculateAndStoreMetrics(
      analysisId,
      analysis.companyName,
      competitors
    );

    await updateProgress(analysisId, 95, "Generating recommendations", job);
    const rec = await generateAndStoreRecommendations(
      analysisId,
      analysis.companyName,
      competitors
    );

    const warnings = ((analysis.warnings as string[]) || []).slice();
    if (!rec.ok && rec.warning) {
      warnings.push(rec.warning);
    }

    await prisma.analysisJob.update({
      where: { id: analysisId },
      data: {
        status: "COMPLETED",
        progress: 100,
        progressMessage: "Completed",
        completedAt: new Date(),
        warnings,
      },
    });
    await job.updateProgress(100);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.analysisJob.update({
      where: { id: analysisId },
      data: {
        status: "FAILED",
        progressMessage: "Failed",
        error: message,
        completedAt: new Date(),
      },
    });
    throw error;
  }
}

async function main() {
  getConfig();
  const worker = new Worker<AnalysisJobData>(
    ANALYSIS_QUEUE_NAME,
    processAnalysis,
    {
      connection: getRedisConnection(),
      concurrency: 1,
    }
  );

  worker.on("completed", (job) => {
    console.log(`[worker] completed analysis ${job.data.analysisId}`);
  });
  worker.on("failed", (job, err) => {
    console.error(
      `[worker] failed analysis ${job?.data.analysisId}:`,
      err.message
    );
  });

  console.log("[worker] Analysis worker started, waiting for jobs...");
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
