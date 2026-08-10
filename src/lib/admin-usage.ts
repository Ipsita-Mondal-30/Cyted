import { prisma } from "@/lib/db";
import {
  estimateCallCostUsd,
  formatUsd,
  getModelRates,
} from "@/lib/ai-pricing";

export type ModelUsage = {
  model: string;
  calls: number;
  successes: number;
  failures: number;
  avgLatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  rates: { inputPer1M: number; outputPer1M: number };
};

export type ProviderUsage = {
  provider: string;
  calls: number;
  successes: number;
  failures: number;
  successRate: number;
  avgLatencyMs: number | null;
  totalResponseChars: number;
  inputTokens: number;
  outputTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  models: ModelUsage[];
};

export type AdminUsagePayload = {
  generatedAt: string;
  costNote: string;
  totals: {
    users: number;
    companies: number;
    analyses: number;
    analysesByStatus: Record<string, number>;
    prompts: number;
    providerCalls: number;
    extractions: number;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    estimatedCostUsd: number;
    estimatedCostFormatted: string;
  };
  providers: ProviderUsage[];
  recentAnalyses: Array<{
    id: string;
    companyName: string;
    status: string;
    progress: number;
    createdAt: Date;
    completedAt: Date | null;
    userEmail: string;
    userName: string | null;
    promptCount: number;
    responseCount: number;
    estimatedCostUsd: number;
    estimatedCostFormatted: string;
  }>;
};

export async function loadAdminUsage(): Promise<AdminUsagePayload> {
  const [
    userCount,
    companyCount,
    analysisCounts,
    promptCount,
    responseCount,
    extractionCount,
    responses,
    recentAnalyses,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.company.count(),
    prisma.analysisJob.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    prisma.prompt.count(),
    prisma.response.count(),
    prisma.extractedResult.count(),
    prisma.response.findMany({
      select: {
        provider: true,
        model: true,
        latencyMs: true,
        error: true,
        rawResponse: true,
        analysisId: true,
        prompt: { select: { prompt: true } },
      },
    }),
    prisma.analysisJob.findMany({
      orderBy: { createdAt: "desc" },
      take: 25,
      select: {
        id: true,
        companyName: true,
        status: true,
        progress: true,
        createdAt: true,
        completedAt: true,
        user: { select: { email: true, name: true } },
        _count: { select: { prompts: true, responses: true } },
      },
    }),
  ]);

  type Agg = {
    provider: string;
    calls: number;
    successes: number;
    failures: number;
    totalLatencyMs: number;
    latencySamples: number;
    totalResponseChars: number;
    inputTokens: number;
    outputTokens: number;
    inputCostUsd: number;
    outputCostUsd: number;
    models: Record<
      string,
      {
        calls: number;
        successes: number;
        failures: number;
        totalLatencyMs: number;
        latencySamples: number;
        inputTokens: number;
        outputTokens: number;
        inputCostUsd: number;
        outputCostUsd: number;
      }
    >;
  };

  const byProvider: Record<string, Agg> = {};
  const costByAnalysis: Record<string, number> = {};
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;

  for (const row of responses) {
    const provider = row.provider || "unknown";
    const model = row.model || "unknown";
    if (!byProvider[provider]) {
      byProvider[provider] = {
        provider,
        calls: 0,
        successes: 0,
        failures: 0,
        totalLatencyMs: 0,
        latencySamples: 0,
        totalResponseChars: 0,
        inputTokens: 0,
        outputTokens: 0,
        inputCostUsd: 0,
        outputCostUsd: 0,
        models: {},
      };
    }

    const cost = estimateCallCostUsd({
      provider,
      model,
      promptText: row.prompt?.prompt,
      responseText: row.error ? null : row.rawResponse,
    });

    totalInputTokens += cost.inputTokens;
    totalOutputTokens += cost.outputTokens;
    totalCostUsd += cost.totalCostUsd;
    costByAnalysis[row.analysisId] =
      (costByAnalysis[row.analysisId] || 0) + cost.totalCostUsd;

    const agg = byProvider[provider];
    agg.calls += 1;
    const failed = Boolean(row.error);
    if (failed) agg.failures += 1;
    else agg.successes += 1;
    if (typeof row.latencyMs === "number") {
      agg.totalLatencyMs += row.latencyMs;
      agg.latencySamples += 1;
    }
    if (row.rawResponse) agg.totalResponseChars += row.rawResponse.length;
    agg.inputTokens += cost.inputTokens;
    agg.outputTokens += cost.outputTokens;
    agg.inputCostUsd += cost.inputCostUsd;
    agg.outputCostUsd += cost.outputCostUsd;

    if (!agg.models[model]) {
      agg.models[model] = {
        calls: 0,
        successes: 0,
        failures: 0,
        totalLatencyMs: 0,
        latencySamples: 0,
        inputTokens: 0,
        outputTokens: 0,
        inputCostUsd: 0,
        outputCostUsd: 0,
      };
    }
    const m = agg.models[model];
    m.calls += 1;
    if (failed) m.failures += 1;
    else m.successes += 1;
    if (typeof row.latencyMs === "number") {
      m.totalLatencyMs += row.latencyMs;
      m.latencySamples += 1;
    }
    m.inputTokens += cost.inputTokens;
    m.outputTokens += cost.outputTokens;
    m.inputCostUsd += cost.inputCostUsd;
    m.outputCostUsd += cost.outputCostUsd;
  }

  const providers: ProviderUsage[] = Object.values(byProvider)
    .map((p) => ({
      provider: p.provider,
      calls: p.calls,
      successes: p.successes,
      failures: p.failures,
      successRate:
        p.calls > 0 ? Math.round((p.successes / p.calls) * 1000) / 10 : 0,
      avgLatencyMs:
        p.latencySamples > 0
          ? Math.round(p.totalLatencyMs / p.latencySamples)
          : null,
      totalResponseChars: p.totalResponseChars,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      inputCostUsd: p.inputCostUsd,
      outputCostUsd: p.outputCostUsd,
      totalCostUsd: p.inputCostUsd + p.outputCostUsd,
      models: Object.entries(p.models)
        .map(([model, m]) => ({
          model,
          calls: m.calls,
          successes: m.successes,
          failures: m.failures,
          avgLatencyMs:
            m.latencySamples > 0
              ? Math.round(m.totalLatencyMs / m.latencySamples)
              : null,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          inputCostUsd: m.inputCostUsd,
          outputCostUsd: m.outputCostUsd,
          totalCostUsd: m.inputCostUsd + m.outputCostUsd,
          rates: getModelRates(p.provider, model),
        }))
        .sort((a, b) => b.totalCostUsd - a.totalCostUsd || b.calls - a.calls),
    }))
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd || b.calls - a.calls);

  const analysesByStatus = Object.fromEntries(
    analysisCounts.map((r) => [r.status, r._count._all])
  );

  return {
    generatedAt: new Date().toISOString(),
    costNote:
      "Costs are estimates from ~4 chars/token on stored prompts + responses × public list prices. Extraction/recommendation/context LLM calls are not stored as Response rows yet, so search-provider calls dominate this rollup.",
    totals: {
      users: userCount,
      companies: companyCount,
      analyses: analysisCounts.reduce((s, r) => s + r._count._all, 0),
      analysesByStatus,
      prompts: promptCount,
      providerCalls: responseCount,
      extractions: extractionCount,
      estimatedInputTokens: totalInputTokens,
      estimatedOutputTokens: totalOutputTokens,
      estimatedCostUsd: totalCostUsd,
      estimatedCostFormatted: formatUsd(totalCostUsd),
    },
    providers,
    recentAnalyses: recentAnalyses.map((a) => {
      const c = costByAnalysis[a.id] || 0;
      return {
        id: a.id,
        companyName: a.companyName,
        status: a.status,
        progress: a.progress,
        createdAt: a.createdAt,
        completedAt: a.completedAt,
        userEmail: a.user.email,
        userName: a.user.name,
        promptCount: a._count.prompts,
        responseCount: a._count.responses,
        estimatedCostUsd: c,
        estimatedCostFormatted: formatUsd(c),
      };
    }),
  };
}
