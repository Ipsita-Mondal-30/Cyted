"use client";

import { useCallback, useEffect, useState } from "react";

type StatusPayload = {
  status: string;
  progress: number;
  progressMessage: string | null;
  error: string | null;
  warnings: unknown;
  companyName: string;
  dbHost?: string;
  polledAt?: string;
};

type ResultsPayload = {
  id: string;
  companyName: string;
  competitors: string[];
  status: string;
  progress: number;
  progressMessage: string | null;
  error: string | null;
  warnings: string[];
  metrics: {
    visibilityScore: number;
    mentionRate: number;
    shareOfVoice: number;
    citationRate: number;
    recommendationRate: number;
    avgRanking: number | null;
    competitorShare: Record<string, number>;
  } | null;
  recommendation: { content: string } | null;
  prompts: Array<{
    id: string;
    category: string;
    prompt: string;
    responses: Array<{
      id: string;
      provider: string;
      model: string;
      rawResponse: string | null;
      latencyMs: number | null;
      error: string | null;
      extracted: {
        mentionedBrands: string[];
        ranking: number | null;
        sentiment: string | null;
        reasoning: string | null;
      } | null;
    }>;
  }>;
};

export function AnalysisDashboard({ jobId }: { jobId: string }) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [results, setResults] = useState<ResultsPayload | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);

  const loadStatus = useCallback(async () => {
    const res = await fetch(
      `/api/analysis/status/${jobId}?t=${Date.now()}`,
      {
        cache: "no-store",
        credentials: "include",
        headers: { "Cache-Control": "no-cache" },
      }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        body.error
          ? `${body.error}${body.dbHost ? ` (db: ${body.dbHost})` : ""}`
          : `Failed to load status (${res.status})`
      );
    }
    return (await res.json()) as StatusPayload;
  }, [jobId]);

  const loadResults = useCallback(async () => {
    const res = await fetch(
      `/api/analysis/results/${jobId}?t=${Date.now()}`,
      {
        cache: "no-store",
        credentials: "include",
        headers: { "Cache-Control": "no-cache" },
      }
    );
    if (!res.ok) {
      throw new Error("Failed to load results");
    }
    return (await res.json()) as ResultsPayload;
  }, [jobId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      try {
        const s = await loadStatus();
        if (cancelled) return;
        setStatus(s);
        setPollCount((n) => n + 1);
        setFetchError(null);

        if (s.status === "COMPLETED" || s.status === "FAILED") {
          const r = await loadResults();
          if (!cancelled) setResults(r);
          return;
        }

        timer = setTimeout(tick, 2000);
      } catch (err) {
        if (!cancelled) {
          setFetchError(err instanceof Error ? err.message : "Error");
          timer = setTimeout(tick, 4000);
        }
      }
    }

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loadStatus, loadResults]);

  const progress = status?.progress ?? 0;
  const jobStatus = status?.status || "…";
  const isDone = jobStatus === "COMPLETED";
  const isFailed = jobStatus === "FAILED";
  const isQueued = jobStatus === "QUEUED";
  const isProcessing = jobStatus === "PROCESSING";

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-10">
      <div>
        <p className="text-sm text-stone-500">Analysis</p>
        <h1 className="mt-1 text-2xl font-semibold text-stone-900">
          {status?.companyName || "Loading…"}
        </h1>
        <p className="mt-1 text-sm text-stone-600">
          {status?.progressMessage || "Waiting for worker…"} ·{" "}
          <span
            className={
              isProcessing
                ? "font-medium text-emerald-700"
                : isFailed
                  ? "font-medium text-red-700"
                  : isDone
                    ? "font-medium text-stone-900"
                    : "font-medium text-amber-700"
            }
          >
            {jobStatus}
          </span>
          {status?.polledAt ? (
            <span className="text-stone-400">
              {" "}
              · polled {new Date(status.polledAt).toLocaleTimeString()}
            </span>
          ) : null}
        </p>
      </div>

      {!isDone && !isFailed && (
        <div className="space-y-3">
          <div>
            <div className="mb-2 flex justify-between text-sm text-stone-600">
              <span>Progress</span>
              <span>{progress}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-stone-200">
              <div
                className="h-full rounded-full bg-emerald-600 transition-all duration-500"
                style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
              />
            </div>
          </div>

          {isQueued && pollCount >= 3 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Still queued after several polls. The Render worker may be down, or
              Vercel and Render may be using different{" "}
              <code className="rounded bg-amber-100 px-1">DATABASE_URL</code>{" "}
              values
              {status?.dbHost ? (
                <>
                  {" "}
                  (this app reads from{" "}
                  <code className="rounded bg-amber-100 px-1">
                    {status.dbHost}
                  </code>
                  )
                </>
              ) : null}
              . Both must point at the same Supabase Postgres.
            </p>
          )}
        </div>
      )}

      {fetchError && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Status poll error: {fetchError}
        </p>
      )}

      {isFailed && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {status?.error || "Analysis failed"}
        </p>
      )}

      {isDone && results?.metrics && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="Visibility" value={fmt(results.metrics.visibilityScore)} />
            <MetricCard label="Share of voice" value={`${fmt(results.metrics.shareOfVoice)}%`} />
            <MetricCard label="Mention rate" value={`${fmt(results.metrics.mentionRate)}%`} />
            <MetricCard label="Citation rate" value={`${fmt(results.metrics.citationRate)}%`} />
          </div>

          <section>
            <h2 className="text-lg font-semibold text-stone-900">Competitor comparison</h2>
            <div className="mt-3 space-y-2">
              {Object.entries(results.metrics.competitorShare || {})
                .sort((a, b) => b[1] - a[1])
                .map(([brand, share]) => (
                  <div key={brand} className="flex items-center gap-3 text-sm">
                    <span className="w-36 truncate text-stone-700">{brand}</span>
                    <div className="h-2 flex-1 rounded-full bg-stone-100">
                      <div
                        className="h-full rounded-full bg-stone-800"
                        style={{ width: `${Math.min(100, share * 100)}%` }}
                      />
                    </div>
                    <span className="w-14 text-right text-stone-500">
                      {(share * 100).toFixed(1)}%
                    </span>
                  </div>
                ))}
            </div>
          </section>

          {results.recommendation && (
            <section>
              <h2 className="text-lg font-semibold text-stone-900">AI recommendations</h2>
              <div className="mt-3 whitespace-pre-wrap rounded-lg border border-stone-200 bg-white p-4 text-sm leading-relaxed text-stone-700">
                {results.recommendation.content}
              </div>
            </section>
          )}

          {Array.isArray(results.warnings) && results.warnings.length > 0 && (
            <p className="text-sm text-amber-700">
              Warnings: {results.warnings.join("; ")}
            </p>
          )}

          <section>
            <h2 className="text-lg font-semibold text-stone-900">Prompt results</h2>
            <div className="mt-3 space-y-4">
              {results.prompts.map((p) => (
                <details
                  key={p.id}
                  className="rounded-lg border border-stone-200 bg-white open:shadow-sm"
                >
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-stone-800">
                    <span className="mr-2 rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600">
                      {p.category}
                    </span>
                    {p.prompt}
                  </summary>
                  <div className="space-y-3 border-t border-stone-100 px-4 py-3">
                    {p.responses.map((r) => (
                      <div key={r.id} className="text-sm">
                        <div className="flex flex-wrap items-center gap-2 font-medium text-stone-800">
                          <span className="capitalize">{r.provider}</span>
                          <span className="text-xs font-normal text-stone-400">
                            {r.model}
                            {r.latencyMs != null ? ` · ${r.latencyMs}ms` : ""}
                          </span>
                          {r.extracted?.sentiment && (
                            <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-800">
                              {r.extracted.sentiment}
                            </span>
                          )}
                          {r.extracted?.ranking != null && (
                            <span className="text-xs text-stone-500">
                              Rank #{r.extracted.ranking}
                            </span>
                          )}
                        </div>
                        {r.error ? (
                          <p className="mt-1 text-red-600">{r.error}</p>
                        ) : (
                          <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-stone-600">
                            {r.rawResponse}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <p className="text-xs font-medium tracking-wide text-stone-500 uppercase">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-stone-900">{value}</p>
    </div>
  );
}

function fmt(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
