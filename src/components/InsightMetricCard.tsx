"use client";

import { RadialGauge } from "@/components/RadialGauge";

export type MetricTone = "poor" | "fair" | "good" | "na";

export function scoreTone(value: number | null | undefined): MetricTone {
  if (value == null || Number.isNaN(value)) return "na";
  if (value < 35) return "poor";
  if (value < 65) return "fair";
  return "good";
}

const TONE_STYLES: Record<
  MetricTone,
  { badge: string; label: string; ring: string }
> = {
  poor: {
    badge: "bg-red-500/15 text-red-300 ring-red-500/30",
    label: "Poor",
    ring: "ring-red-500/20",
  },
  fair: {
    badge: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
    label: "Fair",
    ring: "ring-amber-500/20",
  },
  good: {
    badge: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
    label: "Good",
    ring: "ring-emerald-500/20",
  },
  na: {
    badge: "bg-zinc-500/15 text-zinc-400 ring-zinc-500/30",
    label: "N/A",
    ring: "ring-zinc-500/20",
  },
};

export const TONE_COLORS: Record<MetricTone, string> = {
  poor: "#f87171",
  fair: "#fbbf24",
  good: "#34d399",
  na: "#71717a",
};

export function InsightMetricCard({
  title,
  description,
  value,
  tone,
  percent,
}: {
  title: string;
  description: string;
  value: string;
  tone: MetricTone;
  /** 0–100; renders a progress ring next to the value when provided. */
  percent?: number | null;
}) {
  const styles = TONE_STYLES[tone];
  return (
    <div
      className={`relative flex min-h-[160px] flex-col justify-between border border-zinc-800/80 bg-zinc-950/60 p-5 ring-1 ${styles.ring}`}
    >
      <div>
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold text-white">{title}</h3>
          {tone !== "na" && (
            <span
              className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ${styles.badge}`}
            >
              {styles.label}
            </span>
          )}
        </div>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          {description}
        </p>
      </div>
      <div className="mt-6 flex items-end justify-between gap-4">
        <p className="text-4xl font-semibold tracking-tight text-white">
          {value}
        </p>
        {percent != null && (
          <RadialGauge value={percent} size={56} stroke={6} color={TONE_COLORS[tone]} />
        )}
      </div>
    </div>
  );
}
