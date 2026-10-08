"use client";

import type { ReactNode } from "react";
import { providerMeta } from "@/components/AiProviderStrip";
import { BrandLogo } from "@/components/BrandLogo";
import { TONE_COLORS, type MetricTone } from "@/components/InsightMetricCard";
import { RadialGauge } from "@/components/RadialGauge";
import {
  rankingScore,
  VISIBILITY_WEIGHTS,
  type CategoryStat,
  type HeatmapRow,
  type ProviderStat,
  type RankBucket,
  type SentimentSplit,
} from "@/lib/report-analytics";

export type BrandLogoProps = {
  domain?: string | null;
  logoUrl?: string | null;
  website?: string | null;
};

const YOU_COLOR = "#34d399";
const BRAND_PALETTE = [
  "#38bdf8",
  "#a78bfa",
  "#fbbf24",
  "#fb7185",
  "#2dd4bf",
  "#fb923c",
  "#818cf8",
  "#a3e635",
];
const OTHERS_COLOR = "#52525b";
const TRACK_COLOR = "#27272a";

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function clampPct(n: number) {
  return Math.min(100, Math.max(0, n));
}

function titleCase(s: string) {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function ChartCard({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`border border-zinc-800 bg-zinc-950/60 p-5 sm:p-6 ${className}`}
    >
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="font-sans text-lg font-semibold text-white">{title}</h2>
          {subtitle && (
            <p className="mt-1 text-sm leading-relaxed text-zinc-500">
              {subtitle}
            </p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function VisibilityBreakdown({
  visibilityScore,
  tone,
  mentionRate,
  shareOfVoice,
  recommendationRate,
  citationRate,
  avgRanking,
}: {
  visibilityScore: number;
  tone: MetricTone;
  mentionRate: number;
  shareOfVoice: number;
  recommendationRate: number;
  citationRate: number;
  avgRanking: number | null;
}) {
  const parts = [
    { label: "Mention rate", rate: mentionRate, weight: VISIBILITY_WEIGHTS.mentionRate },
    { label: "Share of voice", rate: shareOfVoice, weight: VISIBILITY_WEIGHTS.shareOfVoice },
    {
      label: "Recommendations",
      rate: recommendationRate,
      weight: VISIBILITY_WEIGHTS.recommendationRate,
    },
    { label: "Citations", rate: citationRate, weight: VISIBILITY_WEIGHTS.citationRate },
    {
      label: "Ranking position",
      rate: rankingScore(avgRanking) * 100,
      weight: VISIBILITY_WEIGHTS.ranking,
    },
  ];

  return (
    <ChartCard
      title="Visibility score breakdown"
      subtitle="How each signal contributes to your overall score (out of 100)."
    >
      <div className="flex flex-col items-center gap-8 sm:flex-row sm:items-center">
        <RadialGauge
          value={visibilityScore}
          size={156}
          stroke={12}
          color={TONE_COLORS[tone]}
        >
          <span className="text-4xl font-semibold tabular-nums text-white">
            {round1(visibilityScore)}
          </span>
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">
            of 100
          </span>
        </RadialGauge>

        <div className="w-full flex-1 space-y-3.5">
          {parts.map((p) => {
            const max = p.weight * 100;
            const earned = (clampPct(p.rate) / 100) * max;
            return (
              <div key={p.label}>
                <div className="mb-1.5 flex items-baseline justify-between text-sm">
                  <span className="text-zinc-300">{p.label}</span>
                  <span className="tabular-nums text-zinc-500">
                    <span className="font-medium text-white">{round1(earned)}</span>{" "}
                    / {max} pts
                  </span>
                </div>
                <div
                  className="h-2 overflow-hidden rounded-full bg-zinc-800"
                  title={`${p.label}: ${round1(p.rate)}% × ${max} pts`}
                >
                  <div
                    className="chart-bar-x h-full rounded-full"
                    style={{
                      width: `${clampPct(p.rate)}%`,
                      background: TONE_COLORS[tone],
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </ChartCard>
  );
}

export function ShareOfVoiceDonut({
  rows,
  logoFor,
}: {
  rows: Array<{ name: string; share: number; isYou: boolean }>;
  logoFor: (name: string) => BrandLogoProps;
}) {
  const sorted = [...rows]
    .map((r) => ({ ...r, pct: (r.share <= 1 ? r.share * 100 : r.share) || 0 }))
    .sort((a, b) => b.pct - a.pct);
  const total = sorted.reduce((a, r) => a + r.pct, 0);

  const MAX_SEGMENTS = 7;
  const head = sorted.slice(0, MAX_SEGMENTS);
  const you = sorted.find((r) => r.isYou);
  if (you && !head.includes(you)) head[head.length - 1] = you;
  const othersPct = Math.max(
    0,
    total - head.reduce((a, r) => a + r.pct, 0)
  );

  const competitorsInHead = head.filter((r) => !r.isYou);
  const segments = [
    ...head.map((r) => ({
      name: r.name,
      pct: r.pct,
      isYou: r.isYou,
      color: r.isYou
        ? YOU_COLOR
        : BRAND_PALETTE[competitorsInHead.indexOf(r) % BRAND_PALETTE.length],
    })),
    ...(othersPct > 0.05
      ? [{ name: "Others", pct: othersPct, isYou: false, color: OTHERS_COLOR }]
      : []),
  ];

  const size = 200;
  const stroke = 26;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const gap = segments.filter((s) => s.pct > 0).length > 1 ? 2 : 0;
  const arcs = segments.map((s, i) => {
    const start = segments
      .slice(0, i)
      .reduce((a, prev) => a + (prev.pct / (total || 1)) * circumference, 0);
    const len = (s.pct / (total || 1)) * circumference;
    return { ...s, start, visible: Math.max(0, len - gap) };
  });

  return (
    <ChartCard
      title="Share of voice"
      subtitle="Each brand's share of all brand mentions across AI answers."
    >
      <div className="flex flex-col items-center gap-8 sm:flex-row">
        <div className="relative shrink-0" style={{ width: size, height: size }}>
          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className="chart-fade -rotate-90"
            aria-hidden
          >
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={TRACK_COLOR}
              strokeWidth={stroke}
            />
            {total > 0 &&
              arcs.map((s) => (
                <circle
                  key={s.name}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={s.isYou ? stroke + 4 : stroke}
                  strokeDasharray={`${s.visible} ${circumference - s.visible}`}
                  strokeDashoffset={-s.start}
                >
                  <title>{`${s.name}: ${round1(s.pct)}%`}</title>
                </circle>
              ))}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="text-3xl font-semibold tabular-nums text-white">
              {round1(you?.pct ?? 0)}%
            </span>
            <span className="text-[11px] uppercase tracking-wider text-zinc-500">
              your share
            </span>
          </div>
        </div>

        <ul className="w-full flex-1 space-y-2">
          {total === 0 && (
            <li className="text-sm text-zinc-500">
              No brand mentions were detected in this run.
            </li>
          )}
          {total > 0 &&
            segments.map((s) => (
              <li key={s.name} className="flex items-center gap-2.5 text-sm">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: s.color }}
                />
                {s.name === "Others" ? (
                  <span className="h-5 w-5 shrink-0" />
                ) : (
                  <BrandLogo name={s.name} size={20} {...logoFor(s.name)} />
                )}
                <span
                  className={`min-w-0 flex-1 truncate ${
                    s.isYou ? "font-medium text-white" : "text-zinc-300"
                  }`}
                >
                  {s.name}
                </span>
                <span className="tabular-nums text-zinc-400">
                  {round1(s.pct)}%
                </span>
              </li>
            ))}
        </ul>
      </div>
    </ChartCard>
  );
}

const GRID_LINES = [100, 75, 50, 25, 0];

export function EngineComparison({
  providers,
  brand,
}: {
  providers: ProviderStat[];
  brand: string;
}) {
  if (!providers.length) return null;
  const series = [
    { key: "mentionRate" as const, label: `Mentions ${brand}`, color: YOU_COLOR },
    { key: "positiveRate" as const, label: "Positive when mentioned", color: "#38bdf8" },
  ];

  return (
    <ChartCard
      title="Performance by answer engine"
      subtitle={`How often each AI assistant mentions ${brand}, and how positively.`}
      action={
        <div className="hidden flex-col gap-1.5 text-xs text-zinc-400 sm:flex">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      }
    >
      <div className="flex gap-3">
        <div className="relative h-52 w-8 shrink-0 text-right text-[10px] tabular-nums text-zinc-600">
          {GRID_LINES.map((g) => (
            <span
              key={g}
              className="absolute right-0 -translate-y-1/2"
              style={{ top: `${100 - g}%` }}
            >
              {g}%
            </span>
          ))}
        </div>
        <div className="relative flex-1">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-52">
            {GRID_LINES.map((g) => (
              <div
                key={g}
                className={`absolute inset-x-0 border-t ${
                  g === 0 ? "border-zinc-700" : "border-dashed border-zinc-800"
                }`}
                style={{ top: `${100 - g}%` }}
              />
            ))}
          </div>
          <div
            className="relative grid gap-4"
            style={{ gridTemplateColumns: `repeat(${providers.length}, minmax(0, 1fr))` }}
          >
            {providers.map((p) => {
              const meta = providerMeta(p.provider);
              return (
                <div key={p.provider} className="flex flex-col items-center">
                  <div className="flex h-52 w-full items-end justify-center gap-1.5 sm:gap-2.5">
                    {series.map((s) => {
                      const v = p[s.key];
                      return (
                        <div
                          key={s.key}
                          className="flex h-full w-full max-w-10 items-end"
                          title={`${meta.label} · ${s.label}: ${v == null ? "n/a" : `${round1(v)}%`}`}
                        >
                          <div
                            className="relative w-full"
                            style={{
                              height: `${clampPct(v ?? 0)}%`,
                              minHeight: v ? 3 : 0,
                            }}
                          >
                            <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 text-[11px] tabular-nums text-zinc-300">
                              {v == null ? "–" : `${Math.round(v)}%`}
                            </span>
                            <div
                              className="chart-bar-y h-full w-full rounded-t-md"
                              style={{ background: s.color }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-3 flex flex-col items-center gap-1 text-center">
                    <div className="flex items-center gap-1.5">
                      <BrandLogo name={meta.label} domain={meta.domain} size={16} />
                      <span className="text-sm font-medium text-zinc-200">
                        {meta.label}
                      </span>
                    </div>
                    <span className="text-[11px] text-zinc-500">
                      {p.avgRank != null ? `Avg rank #${round1(p.avgRank)} · ` : ""}
                      {p.responses} answer{p.responses === 1 ? "" : "s"}
                      {p.failed ? ` · ${p.failed} failed` : ""}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </ChartCard>
  );
}

export function SentimentChart({
  sentiment,
  brand,
}: {
  sentiment: SentimentSplit;
  brand: string;
}) {
  const mentioned = sentiment.positive + sentiment.neutral + sentiment.negative;
  const answered = mentioned + sentiment.notMentioned;
  const parts = [
    { label: "Positive", count: sentiment.positive, color: "#34d399" },
    { label: "Neutral", count: sentiment.neutral, color: "#a1a1aa" },
    { label: "Negative", count: sentiment.negative, color: "#f87171" },
  ];

  return (
    <ChartCard
      title="Sentiment"
      subtitle={`Tone of AI answers that mention ${brand}.`}
    >
      <p className="mb-3 text-sm text-zinc-400">
        Mentioned in{" "}
        <span className="font-medium text-white tabular-nums">{mentioned}</span> of{" "}
        <span className="tabular-nums">{answered}</span> answers
      </p>
      <div className="chart-bar-x flex h-4 overflow-hidden rounded-full bg-zinc-800">
        {mentioned > 0 &&
          parts.map((p) =>
            p.count > 0 ? (
              <div
                key={p.label}
                className="h-full"
                style={{
                  width: `${(p.count / mentioned) * 100}%`,
                  background: p.color,
                }}
                title={`${p.label}: ${p.count}`}
              />
            ) : null
          )}
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3">
        {parts.map((p) => (
          <div key={p.label}>
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
              {p.label}
            </div>
            <p className="mt-1 text-xl font-semibold tabular-nums text-white">
              {mentioned > 0 ? `${Math.round((p.count / mentioned) * 100)}%` : "–"}
            </p>
            <p className="text-[11px] tabular-nums text-zinc-600">
              {p.count} answer{p.count === 1 ? "" : "s"}
            </p>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

export function RankDistribution({
  buckets,
  avgRanking,
}: {
  buckets: RankBucket[];
  avgRanking: number | null;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const total = buckets.reduce((a, b) => a + b.count, 0);
  const shades = ["#34d399", "#4ade80cc", "#a3e635aa", "#fbbf2499", "#f8717199"];

  return (
    <ChartCard
      title="Ranking position"
      subtitle="Where you appear when assistants list options."
      action={
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-wider text-zinc-500">Avg</p>
          <p className="text-xl font-semibold tabular-nums text-white">
            {avgRanking == null ? "–" : `#${round1(avgRanking)}`}
          </p>
        </div>
      }
    >
      {total === 0 ? (
        <p className="text-sm text-zinc-500">
          Not ranked in any answer for this run.
        </p>
      ) : (
        <div className="flex gap-3 pt-5">
          {buckets.map((b, i) => (
            <div
              key={b.label}
              className="flex flex-1 flex-col items-center"
              title={`${b.label}: ${b.count} answer${b.count === 1 ? "" : "s"}`}
            >
              <div className="flex h-32 w-full items-end border-b border-zinc-700">
                <div
                  className="relative w-full"
                  style={{
                    height: `${(b.count / max) * 100}%`,
                    minHeight: b.count ? 3 : 0,
                  }}
                >
                  <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 text-xs tabular-nums text-zinc-300">
                    {b.count}
                  </span>
                  <div
                    className="chart-bar-y h-full w-full rounded-t-md"
                    style={{ background: shades[i] || OTHERS_COLOR }}
                  />
                </div>
              </div>
              <span className="mt-2 text-xs text-zinc-500">{b.label}</span>
            </div>
          ))}
        </div>
      )}
    </ChartCard>
  );
}

export function CategoryBreakdown({
  categories,
  brand,
}: {
  categories: CategoryStat[];
  brand: string;
}) {
  if (!categories.length) return null;
  return (
    <ChartCard
      title="Visibility by prompt type"
      subtitle={`Share of answers mentioning ${brand}, by kind of question asked.`}
    >
      <div className="space-y-4">
        {categories.map((c) => (
          <div key={c.category}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate text-zinc-300">{titleCase(c.category)}</span>
              <span className="shrink-0 tabular-nums text-zinc-500">
                <span className="font-medium text-white">
                  {Math.round(c.mentionRate)}%
                </span>{" "}
                · {c.mentions}/{c.responses}
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="chart-bar-x h-full rounded-full"
                style={{
                  width: `${clampPct(c.mentionRate)}%`,
                  background: `linear-gradient(90deg, #059669, ${YOU_COLOR})`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </ChartCard>
  );
}

export function BrandEngineHeatmap({
  rows,
  providers,
  logoFor,
}: {
  rows: HeatmapRow[];
  providers: ProviderStat[];
  logoFor: (name: string) => BrandLogoProps;
}) {
  if (!rows.length || !providers.length) return null;
  return (
    <ChartCard
      title="Brand mentions by engine"
      subtitle="Percentage of each assistant's answers that mention each brand."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] border-separate border-spacing-1 text-sm">
          <thead>
            <tr>
              <th className="w-44 text-left text-xs font-medium text-zinc-500">Brand</th>
              {providers.map((p) => {
                const meta = providerMeta(p.provider);
                return (
                  <th key={p.provider} className="pb-1 text-xs font-medium text-zinc-400">
                    <span className="inline-flex items-center gap-1.5">
                      <BrandLogo name={meta.label} domain={meta.domain} size={14} />
                      {meta.label}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.brand}>
                <td className="pr-2">
                  <span className="flex items-center gap-2">
                    <BrandLogo name={row.brand} size={18} {...logoFor(row.brand)} />
                    <span
                      className={`truncate ${
                        row.isYou ? "font-medium text-white" : "text-zinc-300"
                      }`}
                    >
                      {row.brand}
                    </span>
                  </span>
                </td>
                {providers.map((p) => {
                  const v = row.rates[p.provider] ?? 0;
                  const base = row.isYou ? "52, 211, 153" : "56, 189, 248";
                  return (
                    <td
                      key={p.provider}
                      className={`rounded-md px-2 py-2 text-center tabular-nums ${
                        v >= 50 ? "font-semibold text-white" : "text-zinc-300"
                      }`}
                      style={{
                        background: `rgba(${base}, ${0.06 + (v / 100) * 0.6})`,
                      }}
                      title={`${row.brand} on ${providerMeta(p.provider).label}: ${round1(v)}%`}
                    >
                      {Math.round(v)}%
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}
