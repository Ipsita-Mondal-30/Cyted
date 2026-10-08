import type { Prisma } from "@prisma/client";
import { buildLogoMap, hostnameFromUrl } from "@/lib/brand-logo";

type JobWithRelations = Prisma.AnalysisJobGetPayload<{
  include: {
    metrics: true;
    recommendation: true;
    prompts: {
      include: {
        responses: {
          include: { extracted: true };
        };
      };
    };
  };
}>;

export function serializeAnalysisReport(job: JobWithRelations) {
  const rawShare =
    (job.metrics?.competitorShare as Record<string, number> | null) || null;
  let positiveSentimentRate: number | null = null;
  let competitorShare: Record<string, number> = {};
  if (rawShare) {
    const { __positiveSentimentRate, ...rest } = rawShare as Record<
      string,
      number
    > & { __positiveSentimentRate?: number };
    positiveSentimentRate =
      typeof __positiveSentimentRate === "number"
        ? Math.round(__positiveSentimentRate * 10000) / 100
        : null;
    competitorShare = rest;
  }

  const context = (job.companyContext || {}) as {
    brandDomains?: Record<string, string>;
  };

  const competitors = (job.competitors as string[]) || [];
  const brandDomains = context.brandDomains || {};
  // Rebuilt rather than read from companyContext: older jobs stored Clearbit
  // URLs there, and that service no longer resolves.
  const brandLogos = buildLogoMap({
    companyName: job.companyName,
    website: job.website,
    companyDomain: brandDomains[job.companyName],
    competitors: competitors.map((name) => ({
      name,
      domain: brandDomains[name],
    })),
  });

  const providers = [
    ...new Set(
      job.prompts.flatMap((p) => p.responses.map((r) => r.provider))
    ),
  ];

  const metrics = job.metrics
    ? {
        visibilityScore: job.metrics.visibilityScore,
        mentionRate: job.metrics.mentionRate,
        shareOfVoice: job.metrics.shareOfVoice,
        citationRate: job.metrics.citationRate,
        recommendationRate: job.metrics.recommendationRate,
        avgRanking: job.metrics.avgRanking,
        competitorShare,
        positiveSentimentRate,
      }
    : null;

  return {
    id: job.id,
    companyName: job.companyName,
    website: job.website,
    description: job.description,
    competitors,
    brandLogos,
    brandDomains: {
      [job.companyName]:
        brandDomains[job.companyName] ||
        hostnameFromUrl(job.website) ||
        undefined,
      ...brandDomains,
    },
    providers,
    status: job.status,
    progress: job.progress,
    progressMessage: job.progressMessage,
    error: job.error,
    warnings: job.warnings,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    metrics,
    recommendation: job.recommendation
      ? { content: job.recommendation.content }
      : null,
    prompts: job.prompts.map((p) => ({
      id: p.id,
      category: p.category,
      prompt: p.prompt,
      responses: p.responses.map((r) => ({
        id: r.id,
        provider: r.provider,
        model: r.model,
        rawResponse: r.rawResponse,
        latencyMs: r.latencyMs,
        error: r.error,
        extracted: r.extracted,
      })),
    })),
  };
}

export type SerializedReport = ReturnType<typeof serializeAnalysisReport>;
