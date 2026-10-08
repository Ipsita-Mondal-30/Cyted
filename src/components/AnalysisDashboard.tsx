"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AI_PROVIDERS, AiProviderStrip, providerMeta } from "@/components/AiProviderStrip";
import { BrandLogo } from "@/components/BrandLogo";
import {
  BrandEngineHeatmap,
  CategoryBreakdown,
  EngineComparison,
  RankDistribution,
  SentimentChart,
  ShareOfVoiceDonut,
  VisibilityBreakdown,
} from "@/components/ReportCharts";
import { ContentSuggestions } from "@/components/ContentSuggestions";
import { CopyReportLink } from "@/components/CopyReportLink";
import {
  InsightMetricCard,
  scoreTone,
  type MetricTone,
} from "@/components/InsightMetricCard";
import { MarkdownReport } from "@/components/MarkdownReport";
import { ReportRankingHero } from "@/components/ReportRankingHero";
import { computeReportAnalytics } from "@/lib/report-analytics";
import {
  parseRecommendationContent,
  type ContentSuggestion,
} from "@/lib/services/recommendation.service";

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
  website?: string | null;
  competitors: string[];
  brandLogos?: Record<string, string>;
  brandDomains?: Record<string, string>;
  providers?: string[];
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
    positiveSentimentRate: number | null;
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

export function AnalysisDashboard({
  jobId,
  mode = "private",
}: {
  jobId: string;
  mode?: "private" | "public";
}) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [results, setResults] = useState<ResultsPayload | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);

  const reportPath = `/report/${jobId}`;
  const isPublic = mode === "public";

  const loadStatus = useCallback(async () => {
    if (isPublic) return null;
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
  }, [jobId, isPublic]);

  const loadResults = useCallback(async () => {
    const url = isPublic
      ? `/api/public/report/${jobId}?t=${Date.now()}`
      : `/api/analysis/results/${jobId}?t=${Date.now()}`;
    const res = await fetch(url, {
      cache: "no-store",
      credentials: isPublic ? "omit" : "include",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!res.ok) {
      throw new Error("Failed to load results");
    }
    return (await res.json()) as ResultsPayload;
  }, [jobId, isPublic]);

  const handleRetry = useCallback(() => {
    setIsRetrying(true);
    setPollCount(0);
    setFetchError(null);
    // The useEffect will automatically restart polling
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function tick() {
      try {
        if (isPublic) {
          const r = await loadResults();
          if (!cancelled) {
            setResults(r);
            setStatus({
              status: r.status,
              progress: r.progress,
              progressMessage: r.progressMessage,
              error: r.error,
              warnings: r.warnings,
              companyName: r.companyName,
            });
            setFetchError(null);
          }
          return;
        }

        const s = await loadStatus();
        if (cancelled || !s) return;
        setStatus(s);
        setPollCount((n) => n + 1);
        setFetchError(null);
        setIsRetrying(false);

        if (s.status === "COMPLETED" || s.status === "FAILED") {
          const r = await loadResults();
          if (!cancelled) setResults(r);
          return;
        }

        timer = setTimeout(tick, 2000);
      } catch (err) {
        if (!cancelled) {
          setFetchError(err instanceof Error ? err.message : "Error");
          if (!isPublic) timer = setTimeout(tick, 4000);
        }
      }
    }

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loadStatus, loadResults, isPublic, isRetrying]);

  const progress = status?.progress ?? 0;
  const jobStatus = status?.status || results?.status || "…";
  const isDone = jobStatus === "COMPLETED";
  const isFailed = jobStatus === "FAILED";
  const isQueued = jobStatus === "QUEUED";
  const isProcessing = jobStatus === "PROCESSING";
  const brand = results?.companyName || status?.companyName || "…";

  const parsedRec = useMemo(() => {
    if (!results?.recommendation?.content) {
      return { markdown: "", contentSuggestions: [] as ContentSuggestion[] };
    }
    return parseRecommendationContent(results.recommendation.content);
  }, [results?.recommendation?.content]);

  const insightCards = useMemo(() => {
    const m = results?.metrics;
    if (!m) return [];
    const positive = m.positiveSentimentRate;
    return [
      {
        title: "Visibility Score",
        description: `${brand} is mentioned in ${fmt(m.mentionRate)}% of responses in your category.`,
        value: `${fmt(m.visibilityScore)}`,
        tone: scoreTone(m.visibilityScore) as MetricTone,
        percent: m.visibilityScore,
      },
      {
        title: "Positive Sentiment",
        description:
          positive == null
            ? "Positive sentiment could not be measured for this run."
            : `When ${brand} is mentioned, the sentiment is positive ${fmt(positive)}% of the time.`,
        value: positive == null ? "N/A" : `${fmt(positive)}%`,
        tone:
          positive == null
            ? ("na" as MetricTone)
            : (scoreTone(positive) as MetricTone),
        percent: positive,
      },
      {
        title: "Citation Share",
        description: `${brand} is cited in ${fmt(m.citationRate)}% of responses in your category.`,
        value: `${fmt(m.citationRate)}%`,
        tone: scoreTone(m.citationRate) as MetricTone,
        percent: m.citationRate,
      },
      {
        title: "Recommendation Rate",
        description: `Assistants recommend ${brand} in ${fmt(m.recommendationRate)}% of tracked answers.`,
        value: `${fmt(m.recommendationRate)}%`,
        tone: scoreTone(m.recommendationRate) as MetricTone,
        percent: m.recommendationRate,
      },
    ];
  }, [results?.metrics, brand]);

  const rankingRows = useMemo(() => {
    const share = results?.metrics?.competitorShare || {};
    const logos = results?.brandLogos || {};
    const domains = results?.brandDomains || {};
    const names = new Set<string>([
      brand,
      ...(results?.competitors || []),
      ...Object.keys(share).filter((k) => !k.startsWith("__")),
    ]);
    return [...names].map((name) => ({
      name,
      share: share[name] ?? (name === brand ? (results?.metrics?.shareOfVoice || 0) / 100 : 0),
      isYou: name === brand,
      logoUrl: logos[name],
      domain: domains[name],
      website: name === brand ? results?.website : null,
    }));
  }, [results, brand]);

  const logoFor = useCallback(
    (name: string) => ({
      domain: results?.brandDomains?.[name],
      logoUrl: results?.brandLogos?.[name],
      website: name === brand ? results?.website : null,
    }),
    [results, brand]
  );

  const prompts = results?.prompts;
  const analytics = useMemo(() => {
    if (!prompts?.length) return null;
    const heatmapBrands = [...rankingRows]
      .sort((a, b) => (b.isYou ? 1 : 0) - (a.isYou ? 1 : 0) || b.share - a.share)
      .slice(0, 8)
      .map((r) => r.name);
    const computed = computeReportAnalytics(prompts, brand, heatmapBrands);
    const order = (p: string) => {
      const i = AI_PROVIDERS.findIndex((x) => x.id === providerMeta(p).id);
      return i === -1 ? AI_PROVIDERS.length : i;
    };
    computed.providers.sort((a, b) => order(a.provider) - order(b.provider));
    return computed;
  }, [prompts, rankingRows, brand]);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-black text-zinc-100">
      <div className="mx-auto max-w-5xl space-y-10 px-4 py-10">
        <header>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">
                AI Visibility Report
              </p>
              <div className="mt-2 flex items-center gap-3">
                <BrandLogo
                  name={brand}
                  website={results?.website}
                  domain={results?.brandDomains?.[brand]}
                  logoUrl={results?.brandLogos?.[brand]}
                  size={36}
                />
                <h1 className="font-sans text-3xl font-semibold tracking-tight text-white">
                  {brand}
                </h1>
              </div>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
                {isPublic
                  ? "Shared AEO report — no login required."
                  : status?.progressMessage ||
                    "Querying answer engines and analyzing the responses."}
                {!isPublic && (
                  <>
                    {" · "}
                    <span
                      className={
                        isProcessing
                          ? "font-medium text-emerald-400"
                          : isFailed
                            ? "font-medium text-red-400"
                            : isDone
                              ? "font-medium text-zinc-200"
                              : "font-medium text-amber-400"
                      }
                    >
                      {jobStatus}
                    </span>
                  </>
                )}
              </p>
            </div>
            {isDone && <CopyReportLink reportPath={reportPath} />}
          </div>

          {(results?.providers?.length || isDone) && (
            <AiProviderStrip
              providers={results?.providers}
              className="mt-5"
            />
          )}

          {results?.competitors?.length ? (
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <span className="text-xs text-zinc-500">Tracked competitors</span>
              {results.competitors.map((c) => (
                <span
                  key={c}
                  className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-xs text-zinc-300"
                >
                  <BrandLogo
                    name={c}
                    domain={results.brandDomains?.[c]}
                    logoUrl={results.brandLogos?.[c]}
                    size={16}
                  />
                  {c}
                </span>
              ))}
            </div>
          ) : null}
        </header>

        {!isPublic && !isDone && !isFailed && (
          <div className="space-y-3 border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="mb-2 flex justify-between text-sm text-zinc-400">
              <span>Progress</span>
              <span>{progress}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
              />
            </div>
            {isQueued && pollCount >= 10 && (
              <div className="mt-3 space-y-2 rounded border border-amber-500/30 bg-amber-500/10 p-3">
                <p className="text-sm text-amber-200/90">
                  Analysis is taking longer than expected. The worker may be processing other jobs or starting up.
                </p>
                <button
                  onClick={handleRetry}
                  disabled={isRetrying}
                  className="rounded bg-amber-500/20 px-3 py-1.5 text-sm font-medium text-amber-100 hover:bg-amber-500/30 disabled:opacity-50"
                >
                  {isRetrying ? "Checking..." : "Check Status Again"}
                </button>
              </div>
            )}
          </div>
        )}

        {fetchError && (
          <p className="border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            {isPublic ? "Could not load report: " : "Status poll error: "}
            {fetchError}
          </p>
        )}

        {isFailed && (
          <p className="border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {status?.error || "Analysis failed"}
          </p>
        )}

        {isDone && results?.metrics && (
          <>
            <ReportRankingHero
              companyName={brand}
              website={results.website}
              logoUrl={results.brandLogos?.[brand]}
              brandDomain={results.brandDomains?.[brand]}
              rows={rankingRows}
              reportPath={reportPath}
              showCta={isPublic}
            />

            <section>
              <div className="grid grid-cols-1 border border-zinc-800 sm:grid-cols-2">
                {insightCards.map((card, i) => (
                  <div
                    key={card.title}
                    className={[
                      i % 2 === 1 ? "sm:border-l sm:border-zinc-800" : "",
                      i >= 2 ? "border-t border-zinc-800" : "",
                    ].join(" ")}
                  >
                    <InsightMetricCard {...card} />
                  </div>
                ))}
              </div>
            </section>

            <div className="grid gap-4 lg:grid-cols-2">
              <VisibilityBreakdown
                visibilityScore={results.metrics.visibilityScore}
                tone={scoreTone(results.metrics.visibilityScore)}
                mentionRate={results.metrics.mentionRate}
                shareOfVoice={results.metrics.shareOfVoice}
                recommendationRate={results.metrics.recommendationRate}
                citationRate={results.metrics.citationRate}
                avgRanking={results.metrics.avgRanking}
              />
              <ShareOfVoiceDonut rows={rankingRows} logoFor={logoFor} />
            </div>

            {analytics && (
              <>
                <EngineComparison providers={analytics.providers} brand={brand} />

                <div className="grid gap-4 lg:grid-cols-2">
                  <SentimentChart sentiment={analytics.sentiment} brand={brand} />
                  <RankDistribution
                    buckets={analytics.rankBuckets}
                    avgRanking={results.metrics.avgRanking}
                  />
                </div>

                <CategoryBreakdown categories={analytics.categories} brand={brand} />

                <BrandEngineHeatmap
                  rows={analytics.heatmap}
                  providers={analytics.providers}
                  logoFor={logoFor}
                />
              </>
            )}

            {parsedRec.contentSuggestions.length > 0 && (
              <ContentSuggestions suggestions={parsedRec.contentSuggestions} />
            )}

            {parsedRec.markdown && (
              <section className="border border-zinc-800 bg-zinc-950/60 p-5 sm:p-8">
                <h2 className="mb-6 font-sans text-2xl font-semibold tracking-tight text-white">
                  Strategic recommendations
                </h2>
                <MarkdownReport content={parsedRec.markdown} />
              </section>
            )}

            {Array.isArray(results.warnings) && results.warnings.length > 0 && (
              <p className="text-sm text-amber-300/90">
                Warnings: {results.warnings.join("; ")}
              </p>
            )}

            {!isPublic && (
              <section>
                <h2 className="font-sans text-lg font-semibold text-white">
                  Prompt results
                </h2>
                <div className="mt-4 space-y-3">
                  {results.prompts.map((p) => (
                    <details
                      key={p.id}
                      className="border border-zinc-800 bg-zinc-950/50 open:bg-zinc-900/40"
                    >
                      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-zinc-200">
                        <span className="mr-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-zinc-400">
                          {p.category}
                        </span>
                        {p.prompt}
                      </summary>
                      <div className="space-y-4 border-t border-zinc-800 px-4 py-4">
                        {p.responses.map((r) => (
                          <div key={r.id} className="text-sm">
                            <div className="flex flex-wrap items-center gap-2 font-medium text-zinc-200">
                              <span className="capitalize">{r.provider}</span>
                              <span className="text-xs font-normal text-zinc-500">
                                {r.model}
                                {r.latencyMs != null
                                  ? ` · ${r.latencyMs}ms`
                                  : ""}
                              </span>
                              {r.extracted?.sentiment && (
                                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-300">
                                  {r.extracted.sentiment}
                                </span>
                              )}
                              {r.extracted?.ranking != null && (
                                <span className="text-xs text-zinc-500">
                                  Rank #{r.extracted.ranking}
                                </span>
                              )}
                            </div>
                            {r.error ? (
                              <p className="mt-1 text-red-400">{r.error}</p>
                            ) : (
                              <p className="mt-1 line-clamp-5 whitespace-pre-wrap text-zinc-400">
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
            )}
          </>
        )}
      </div>
    </div>
  );
}

function fmt(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
