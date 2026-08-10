import Link from "next/link";
import { AdminProviderToggles } from "@/components/AdminProviderToggles";
import { loadAdminUsage } from "@/lib/admin-usage";
import { formatUsd } from "@/lib/ai-pricing";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminPage() {
  const data = await loadAdminUsage();
  const statusEntries = Object.entries(data.totals.analysesByStatus || {});

  return (
    <main className="mx-auto min-h-full max-w-6xl px-4 py-10">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-emerald-700 uppercase">
            Admin · no auth
          </p>
          <h1 className="mt-1 text-3xl font-semibold text-stone-900">
            AI usage & cost
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-stone-600">
            Aggregate provider usage and estimated spend across all accounts and
            analyses. Toggle answer engines below for future jobs.
          </p>
        </div>
        <div className="text-right text-xs text-stone-500">
          <p>Generated {new Date(data.generatedAt).toLocaleString()}</p>
          <Link href="/" className="text-emerald-700 underline">
            Back to app
          </Link>
        </div>
      </div>

      <AdminProviderToggles />

      <section className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Est. total cost"
          value={data.totals.estimatedCostFormatted}
          emphasize
        />
        <StatCard
          label="Provider calls"
          value={String(data.totals.providerCalls)}
        />
        <StatCard
          label="Est. input tokens"
          value={formatTokens(data.totals.estimatedInputTokens)}
        />
        <StatCard
          label="Est. output tokens"
          value={formatTokens(data.totals.estimatedOutputTokens)}
        />
        <StatCard label="Users" value={String(data.totals.users)} />
        <StatCard label="Companies" value={String(data.totals.companies)} />
        <StatCard label="Analyses" value={String(data.totals.analyses)} />
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

      <p className="mt-4 text-xs leading-relaxed text-stone-500">
        {data.costNote}
      </p>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-stone-900">
          Cost by provider
        </h2>
        {data.providers.length === 0 ? (
          <p className="mt-3 text-sm text-stone-600">No provider calls yet.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {data.providers.map((p) => {
              const share =
                data.totals.estimatedCostUsd > 0
                  ? (p.totalCostUsd / data.totals.estimatedCostUsd) * 100
                  : 0;
              return (
                <div
                  key={p.provider}
                  className="rounded-lg border border-stone-200 bg-white p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-base font-semibold capitalize text-stone-900">
                      {p.provider}
                    </h3>
                    <p className="text-sm text-stone-600">
                      <span className="font-semibold text-stone-900">
                        {formatUsd(p.totalCostUsd)}
                      </span>
                      {" · "}
                      {share.toFixed(1)}% of spend · {p.calls} calls ·{" "}
                      {p.successRate}% success
                      {p.avgLatencyMs != null
                        ? ` · avg ${p.avgLatencyMs}ms`
                        : ""}
                    </p>
                  </div>

                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-stone-100">
                    <div
                      className="h-full rounded-full bg-emerald-600"
                      style={{ width: `${Math.min(100, share)}%` }}
                    />
                  </div>

                  <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5 text-sm">
                    <MiniStat label="Input cost" value={formatUsd(p.inputCostUsd)} />
                    <MiniStat
                      label="Output cost"
                      value={formatUsd(p.outputCostUsd)}
                    />
                    <MiniStat
                      label="Input tokens"
                      value={formatTokens(p.inputTokens)}
                    />
                    <MiniStat
                      label="Output tokens"
                      value={formatTokens(p.outputTokens)}
                    />
                    <MiniStat
                      label="Failures"
                      value={`${p.failures} / ${p.calls}`}
                    />
                  </div>

                  {p.models.length > 0 && (
                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full min-w-[720px] text-left text-sm">
                        <thead className="text-xs uppercase tracking-wide text-stone-500">
                          <tr>
                            <th className="py-1 pr-3 font-medium">Model</th>
                            <th className="py-1 pr-3 font-medium">Calls</th>
                            <th className="py-1 pr-3 font-medium">OK / Fail</th>
                            <th className="py-1 pr-3 font-medium">Avg latency</th>
                            <th className="py-1 pr-3 font-medium">
                              Rate ($/1M in·out)
                            </th>
                            <th className="py-1 pr-3 font-medium">Tokens in·out</th>
                            <th className="py-1 font-medium">Est. cost</th>
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
                              <td className="py-1.5 pr-3">
                                {m.successes} / {m.failures}
                              </td>
                              <td className="py-1.5 pr-3">
                                {m.avgLatencyMs != null
                                  ? `${m.avgLatencyMs}ms`
                                  : "—"}
                              </td>
                              <td className="py-1.5 pr-3 text-xs text-stone-500">
                                ${m.rates.inputPer1M} · ${m.rates.outputPer1M}
                              </td>
                              <td className="py-1.5 pr-3 text-xs">
                                {formatTokens(m.inputTokens)} ·{" "}
                                {formatTokens(m.outputTokens)}
                              </td>
                              <td className="py-1.5 font-medium">
                                {formatUsd(m.totalCostUsd)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-stone-900">
          Recent analyses
        </h2>
        <div className="mt-4 overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead className="border-b border-stone-200 bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Prompts</th>
                <th className="px-3 py-2 font-medium">Calls</th>
                <th className="px-3 py-2 font-medium">Est. cost</th>
                <th className="px-3 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {data.recentAnalyses.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-stone-500">
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
                    <td className="px-3 py-2 font-medium">
                      {a.estimatedCostFormatted}
                    </td>
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

function StatCard({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        emphasize
          ? "border-emerald-200 bg-emerald-50"
          : "border-stone-200 bg-white"
      }`}
    >
      <p className="text-xs font-medium tracking-wide text-stone-500 uppercase">
        {label}
      </p>
      <p
        className={`mt-2 text-2xl font-semibold ${
          emphasize ? "text-emerald-900" : "text-stone-900"
        }`}
      >
        {value}
      </p>
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

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
