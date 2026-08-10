import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Public admin usage endpoint — no auth by design.
 * Aggregates AI provider usage across all accounts / analyses.
 */
export async function GET() {
  try {
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
          createdAt: true,
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

    type ProviderAgg = {
      provider: string;
      calls: number;
      successes: number;
      failures: number;
      avgLatencyMs: number | null;
      totalLatencyMs: number;
      latencySamples: number;
      totalResponseChars: number;
      models: Record<
        string,
        {
          calls: number;
          successes: number;
          failures: number;
          avgLatencyMs: number | null;
          totalLatencyMs: number;
          latencySamples: number;
        }
      >;
    };

    const byProvider: Record<string, ProviderAgg> = {};

    for (const row of responses) {
      const provider = row.provider || "unknown";
      if (!byProvider[provider]) {
        byProvider[provider] = {
          provider,
          calls: 0,
          successes: 0,
          failures: 0,
          avgLatencyMs: null,
          totalLatencyMs: 0,
          latencySamples: 0,
          totalResponseChars: 0,
          models: {},
        };
      }
      const agg = byProvider[provider];
      agg.calls += 1;
      const failed = Boolean(row.error);
      if (failed) agg.failures += 1;
      else agg.successes += 1;

      if (typeof row.latencyMs === "number") {
        agg.totalLatencyMs += row.latencyMs;
        agg.latencySamples += 1;
      }
      if (row.rawResponse) {
        agg.totalResponseChars += row.rawResponse.length;
      }

      const model = row.model || "unknown";
      if (!agg.models[model]) {
        agg.models[model] = {
          calls: 0,
          successes: 0,
          failures: 0,
          avgLatencyMs: null,
          totalLatencyMs: 0,
          latencySamples: 0,
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
    }

    const providers = Object.values(byProvider)
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
          }))
          .sort((a, b) => b.calls - a.calls),
      }))
      .sort((a, b) => b.calls - a.calls);

    const analysesByStatus = Object.fromEntries(
      analysisCounts.map((r) => [r.status, r._count._all])
    );
    const analysisTotal = analysisCounts.reduce(
      (sum, r) => sum + r._count._all,
      0
    );

    return NextResponse.json(
      {
        generatedAt: new Date().toISOString(),
        totals: {
          users: userCount,
          companies: companyCount,
          analyses: analysisTotal,
          analysesByStatus,
          prompts: promptCount,
          providerCalls: responseCount,
          extractions: extractionCount,
        },
        providers,
        recentAnalyses: recentAnalyses.map((a) => ({
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
        })),
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      }
    );
  } catch (error) {
    console.error("[admin/usage]", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to load usage",
      },
      { status: 500 }
    );
  }
}
