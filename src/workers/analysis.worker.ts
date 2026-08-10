import { Job, Worker } from "bullmq";
import { getConfig, redisHostForLogs } from "@/lib/config";
import { prisma, ensurePrismaConnected, prismaWrite } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import {
  getEnabledProviders,
  listEnabledProviderNames,
} from "@/lib/providers/provider-manager";
import { resolveBrandsAndCompetitors } from "@/lib/services/competitor.service";
import { extractFromResponses } from "@/lib/services/extraction.service";
import { calculateAndStoreMetrics } from "@/lib/services/metrics.service";
import {
  buildCompanyContext,
  generateAndStorePrompts,
} from "@/lib/services/prompt.service";
import { generateAndStoreRecommendations } from "@/lib/services/recommendation.service";
import { searchAllProviders } from "@/lib/services/search.service";
import {
  ANALYSIS_QUEUE_NAME,
  getRedisConnectionOptions,
} from "@/queue/queue";

const log = createLogger("worker");

type AnalysisJobData = { analysisId: string };

async function updateProgress(
  analysisId: string,
  progress: number,
  progressMessage: string,
  job?: Job
) {
  log.step("progress", progressMessage, { analysisId, progress });
  await prismaWrite(() =>
    prisma.analysisJob.update({
      where: { id: analysisId },
      data: { progress, progressMessage },
    })
  );
  if (job) {
    await job.updateProgress(progress);
  }
}

async function processAnalysis(job: Job<AnalysisJobData>) {
  const { analysisId } = job.data;
  const startedAt = Date.now();
  log.info("Picked up job", {
    analysisId,
    bullJobId: job.id,
    attempt: job.attemptsMade + 1,
  });

  await ensurePrismaConnected();

  const analysis = await prisma.analysisJob.findUnique({
    where: { id: analysisId },
  });

  if (!analysis) {
    log.error("Analysis record missing in DB", { analysisId });
    throw new Error(`Analysis ${analysisId} not found`);
  }

  const seedCompetitors = ((analysis.competitors as string[]) || []).slice(
    0,
    getConfig().maxCompetitors
  );
  const enabledProviders = await listEnabledProviderNames();
  log.info("Loaded analysis", {
    analysisId,
    companyName: analysis.companyName,
    competitors: seedCompetitors,
    status: analysis.status,
    enabledProviders,
  });
  if (!enabledProviders.some((p) => p.startsWith("claude:"))) {
    log.warn(
      "Claude is NOT enabled for this job — set ANTHROPIC_API_KEY and enable it in /admin",
      { analysisId }
    );
  }

  // Clean prior attempt data so retries don't duplicate prompts/responses
  await prisma.$transaction([
    prisma.extractedResult.deleteMany({
      where: { response: { analysisId } },
    }),
    prisma.response.deleteMany({ where: { analysisId } }),
    prisma.prompt.deleteMany({ where: { analysisId } }),
    prisma.metrics.deleteMany({ where: { analysisId } }),
    prisma.recommendation.deleteMany({ where: { analysisId } }),
  ]);

  try {
    await prisma.analysisJob.update({
      where: { id: analysisId },
      data: {
        status: "PROCESSING",
        progress: 5,
        progressMessage: "Resolving brands & discovering competitors",
        error: null,
      },
    });
    await job.updateProgress(5);

    log.step("0/6-brands", "Correcting names + discovering top competitors…", {
      analysisId,
    });
    let companyName = analysis.companyName;
    let competitors = seedCompetitors;
    let brandLogos: Record<string, string> = {};
    let brandDomains: Record<string, string> = {};
    try {
      const resolved = await resolveBrandsAndCompetitors({
        companyName: analysis.companyName,
        website: analysis.website,
        description: analysis.description,
        competitors: seedCompetitors,
      });
      companyName = resolved.companyName;
      competitors = resolved.competitors;
      brandLogos = resolved.brandLogos;
      brandDomains = resolved.brandDomains;
      await prisma.analysisJob.update({
        where: { id: analysisId },
        data: {
          companyName,
          competitors,
        },
      });
      // Keep company profile in sync with corrected name when possible
      await prisma.company
        .update({
          where: { id: analysis.companyId },
          data: {
            name: companyName,
            competitors,
          },
        })
        .catch(() => undefined);
      log.step("0/6-brands", "Brand resolution complete", {
        analysisId,
        companyName,
        competitors,
        corrections: resolved.corrections,
        discovered: resolved.discoveredCompetitors,
      });
    } catch (err) {
      log.warn("Brand resolution failed — continuing with user input", {
        analysisId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await updateProgress(analysisId, 10, "Creating company context", job);

    log.step("1/6-context", "Building company context via Gemini…", {
      analysisId,
    });
    const context = await buildCompanyContext({
      companyName,
      website: analysis.website,
      description: analysis.description,
      competitors,
    });
    const contextWithLogos = {
      ...context,
      brandLogos,
      brandDomains,
    };
    log.step("1/6-context", "Company context ready", {
      analysisId,
      industry: context.industry,
      products: context.products.length,
      keywords: context.keywords.length,
      logoCount: Object.keys(brandLogos).length,
    });

    await prisma.analysisJob.update({
      where: { id: analysisId },
      data: { companyContext: contextWithLogos },
    });

    await updateProgress(analysisId, 20, "Generating prompts", job);
    log.step("2/6-prompts", "Generating prompts via Gemini…", {
      analysisId,
      categories: getConfig().promptCategories,
      perCategory: getConfig().promptsPerCategory,
    });
    const promptCount = await generateAndStorePrompts(
      analysisId,
      companyName,
      context
    );
    log.step("2/6-prompts", "Prompts stored", { analysisId, promptCount });

    const prompts = await prisma.prompt.findMany({
      where: { analysisId },
      select: { id: true, prompt: true, category: true },
    });

    if (prompts.length === 0) {
      throw new Error("No prompts were generated");
    }
    log.debug("Prompt list", prompts.map((p) => ({ category: p.category, prompt: p.prompt })));

    const providers = (await getEnabledProviders()).map((p) => p.name);
    log.step("3/6-search", "Searching AI providers", {
      analysisId,
      providers,
      promptCount: prompts.length,
      totalCalls: prompts.length * providers.length,
      searchConcurrency: getConfig().searchConcurrency,
      perProviderConcurrency: getConfig().perProviderConcurrency,
      extractConcurrency: getConfig().extractConcurrency,
    });
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

    const responseStats = await prisma.response.groupBy({
      by: ["provider"],
      where: { analysisId },
      _count: true,
    });
    const failedResponses = await prisma.response.count({
      where: { analysisId, error: { not: null } },
    });
    log.step("3/6-search", "Search complete", {
      analysisId,
      byProvider: responseStats,
      failedResponses,
    });

    await updateProgress(analysisId, 70, "Extracting structured results", job);
    log.step("4/6-extract", "Extracting structured JSON from responses…", {
      analysisId,
    });
    await extractFromResponses(
      analysisId,
      companyName,
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
    const extractionCount = await prisma.extractedResult.count({
      where: { response: { analysisId } },
    });
    log.step("4/6-extract", "Extraction complete", {
      analysisId,
      extractionCount,
    });

    await updateProgress(analysisId, 90, "Calculating metrics", job);
    log.step("5/6-metrics", "Calculating metrics…", { analysisId });
    await calculateAndStoreMetrics(
      analysisId,
      companyName,
      competitors
    );
    const metrics = await prisma.metrics.findUnique({ where: { analysisId } });
    log.step("5/6-metrics", "Metrics stored", {
      analysisId,
      visibilityScore: metrics?.visibilityScore,
      mentionRate: metrics?.mentionRate,
      shareOfVoice: metrics?.shareOfVoice,
    });

    await updateProgress(analysisId, 95, "Generating recommendations", job);
    log.step("6/6-recs", "Generating recommendations…", { analysisId });
    const rec = await generateAndStoreRecommendations(
      analysisId,
      companyName,
      competitors
    );

    const warnings = ((analysis.warnings as string[]) || []).slice();
    if (!rec.ok && rec.warning) {
      warnings.push(rec.warning);
      log.warn("Recommendations soft-failed", { analysisId, warning: rec.warning });
    } else {
      log.step("6/6-recs", "Recommendations stored", { analysisId });
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

    log.info("Analysis completed", {
      analysisId,
      durationMs: Date.now() - startedAt,
      warnings,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("Analysis failed", {
      analysisId,
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
      durationMs: Date.now() - startedAt,
    });
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
  const config = getConfig();
  const providers = await listEnabledProviderNames().catch((err) => {
    log.warn("Could not list providers at startup", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [] as string[];
  });
  const redisOpts = getRedisConnectionOptions();

  log.info("Starting analysis worker", {
    redis: redisHostForLogs(config.redisUrl),
    tls: Boolean(redisOpts.tls),
    dbHost: (() => {
      try {
        return new URL(config.databaseUrl).hostname;
      } catch {
        return "unknown";
      }
    })(),
    providers,
    hasOpenAI: Boolean(config.openaiApiKey),
    hasGemini: Boolean(config.geminiApiKey),
    hasClaude: Boolean(config.anthropicApiKey),
    hasGroq: Boolean(config.groqApiKey),
    categories: config.promptCategories,
    promptsPerCategory: config.promptsPerCategory,
    concurrentRequests: config.concurrentRequests,
    searchConcurrency: config.searchConcurrency,
    extractConcurrency: config.extractConcurrency,
    perProviderConcurrency: config.perProviderConcurrency,
    maxRetries: config.maxRetries,
  });

  if (!config.anthropicApiKey) {
    log.warn(
      "ANTHROPIC_API_KEY is empty — Claude will not appear until you set it and enable it in /admin"
    );
  }

  if (!redisOpts.tls && redisHostForLogs(config.redisUrl).includes("upstash.io")) {
    log.error(
      "Upstash REDIS_URL is missing TLS (must be rediss://). Connections will reset with ECONNRESET/EPIPE."
    );
  }

  const worker = new Worker<AnalysisJobData>(
    ANALYSIS_QUEUE_NAME,
    processAnalysis,
    {
      connection: redisOpts,
      concurrency: 1,
      lockDuration: 10 * 60 * 1000,
      stalledInterval: 60 * 1000,
      maxStalledCount: 3,
    }
  );

  worker.on("ready", () => {
    log.info("Worker ready — listening on queue", {
      queue: ANALYSIS_QUEUE_NAME,
    });
  });
  worker.on("active", (job) => {
    log.info("Job became active", {
      analysisId: job.data.analysisId,
      bullJobId: job.id,
    });
  });
  worker.on("completed", (job) => {
    log.info("BullMQ marked job completed", {
      analysisId: job.data.analysisId,
    });
  });
  worker.on("failed", (job, err) => {
    log.error("BullMQ marked job failed", {
      analysisId: job?.data.analysisId,
      error: err.message,
    });
  });
  worker.on("error", (err) => {
    log.error("Worker error", err.message);
  });

  log.info("Analysis worker process started, waiting for jobs…");
}

main().catch((err) => {
  log.error("Fatal worker startup error", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  log.error("uncaughtException", {
    error: err.message,
    stack: err.stack,
  });
});

process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
