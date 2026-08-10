import Link from "next/link";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type ProviderUsage = {
  provider: string;
  calls: number;
  successes: number;
  failures: number;
  successRate: number;
  avgLatencyMs: number | null;
  totalResponseChars: number;
  models: Array<{
    model: string;
    calls: number;
    successes: number;
    failures: number;
    avgLatencyMs: number | null;
  }>;
};

async function loadUsage() {
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

  const byProvider: Record<
    string,
    {
      provider: string;
      calls: number;
      successes: number;
      failures: number;
      totalLatencyMs: number;
      latencySamples: number;
      totalResponseChars: number;
      models: Record<
        string,
        {
          calls: number;
          successes: number;
          failures: number;
          totalLatencyMs: number;
          latencySamples: number;
        }
      >;
    }
  > = {};

  for (const row of responses) {
    const provider = row.provider || "unknown";
    if (!byProvider[provider]) {
      byProvider[provider] = {
        provider,
        calls: 0,
        successes: 0,
        failures: 0,
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
    if (row.rawResponse) agg.totalResponseChars += row.rawResponse.length;

    const model = row.model || "unknown";
    if (!agg.models[model]) {
      agg.models[model] = {
        calls: 0,
        successes: 0,
        failures: 0,
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

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      users: userCount,
      companies: companyCount,
      analyses: analysisCounts.reduce((s, r) => s + r._count._all, 0),
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
  };
}

export default async function AdminPage() {
  const data = await loadUsage();
  const statusEntries = Object.entries(data.totals.analysesByStatus || {});

  return (
    <main className="mx-auto min-h-full max-w-6xl px-4 py-10">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-emerald-700 uppercase">
            Admin · no auth
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-stone-900">
            AI usage
          </h1>
          <p className="mt-2 text-sm text-stone-600">
            Aggregate provider usage across all accounts and analyses.
          </p>
        </div>
        <div className="text-right text-xs text-stone-500">
          <p>Generated {new Date(data.generatedAt).toLocaleString()}</p>
          <Link href="/" className="text-emerald-700 underline">
            Back to app
          </Link>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Users" value={String(data.totals.users)} />
        <StatCard label="Companies" value={String(data.totals.companies)} />
        <StatCard label="Analyses" value={String(data.totals.analyses)} />
        <StatCard
          label="Provider calls"
          value={String(data.totals.providerCalls)}
        />
        <StatCard label="Prompts" value={String(data.totals.prompts)} />
        <StatCard label="Extractions" value={String(data.totals.extractions)} />
        {statusEntries.map(([status, count]) => (
          <StatCard
            key={status}
            label={`Analyses · ${status}`}
            value={String(count)}
          />
        ))}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-stone-900">By provider</h2>
        {data.providers.length === 0 ? (
          <p className="mt-3 text-sm text-stone-600">No provider calls yet.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {data.providers.map((p) => (
              <div
                key={p.provider}
                className="rounded-lg border border-stone-200 bg-white p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-base font-semibold capitalize text-stone-900">
                    {p.provider}
                  </h3>
                  <p className="text-sm text-stone-500">
                    {p.calls} calls · {p.successRate}% success
                    {p.avgLatencyMs != null
                      ? ` · avg ${p.avgLatencyMs}ms`
                      : ""}
                  </p>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-4 text-sm">
                  <MiniStat label="Successes" value={String(p.successes)} />
                  <MiniStat label="Failures" value={String(p.failures)} />
                  <MiniStat
                    label="Avg latency"
                    value={p.avgLatencyMs != null ? `${p.avgLatencyMs}ms` : "—"}
                  />
                  <MiniStat
                    label="Response chars"
                    value={formatChars(p.totalResponseChars)}
                  />
                </div>
                {p.models.length > 0 && (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full min-w-[480px] text-left text-sm">
                      <thead className="text-xs uppercase tracking-wide text-stone-500">
                        <tr>
                          <th className="py-1 pr-3 font-medium">Model</th>
                          <th className="py-1 pr-3 font-medium">Calls</th>
                          <th className="py-1 pr-3 font-medium">OK</th>
                          <th className="py-1 pr-3 font-medium">Fail</th>
                          <th className="py-1 font-medium">Avg latency</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.models.map((m) => (
                          <tr
                            key={m.model}
                            className="border-t border-stone-100 text-stone-700"
                          >
                            <td className="py-1.5 pr-3 font-mono text-xs">
                              {m.model}
                            </td>
                            <td className="py-1.5 pr-3">{m.calls}</td>
                            <td className="py-1.5 pr-3">{m.successes}</td>
                            <td className="py-1.5 pr-3">{m.failures}</td>
                            <td className="py-1.5">
                              {m.avgLatencyMs != null
                                ? `${m.avgLatencyMs}ms`
                                : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-stone-900">
          Recent analyses
        </h2>
        <div className="mt-4 overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-stone-200 bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Prompts</th>
                <th className="px-3 py-2 font-medium">Calls</th>
                <th className="px-3 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {data.recentAnalyses.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-4 text-stone-500"
                  >
                    No analyses yet.
                  </td>
                </tr>
              ) : (
                data.recentAnalyses.map((a) => (
                  <tr
                    key={a.id}
                    className="border-t border-stone-100 text-stone-700"
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/dashboard/${a.id}`}
                        className="font-medium text-emerald-800 hover:underline"
                      >
                        {a.companyName}
                      </Link>
                      <div className="font-mono text-[10px] text-stone-400">
                        {a.id}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div>{a.userName || "—"}</div>
                      <div className="text-xs text-stone-500">{a.userEmail}</div>
                    </td>
                    <td className="px-3 py-2">
                      {a.status}
                      {a.status === "PROCESSING" ? ` (${a.progress}%)` : ""}
                    </td>
                    <td className="px-3 py-2">{a.promptCount}</td>
                    <td className="px-3 py-2">{a.responseCount}</td>
                    <td className="px-3 py-2 text-xs text-stone-500">
                      {new Date(a.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-stone-500">
          JSON feed:{" "}
          <Link href="/api/admin/usage" className="underline">
            /api/admin/usage
          </Link>
        </p>
      </section>
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <p className="text-xs font-medium tracking-wide text-stone-500 uppercase">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold text-stone-900">{value}</p>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-stone-50 px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-stone-500">
        {label}
      </p>
      <p className="font-medium text-stone-800">{value}</p>
    </div>
  );
}

function formatChars(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
