"use client";

import { BrandLogo } from "@/components/BrandLogo";
import { CopyReportLink } from "@/components/CopyReportLink";

export type RankRow = {
  name: string;
  share: number; // 0-1 or 0-100 — we normalize
  isYou?: boolean;
  logoUrl?: string | null;
  domain?: string | null;
  website?: string | null;
};

function asPercent(share: number) {
  const pct = share <= 1 ? share * 100 : share;
  return pct;
}

export function ReportRankingHero({
  companyName,
  website,
  logoUrl,
  brandDomain,
  rows,
  reportPath,
  showCta = true,
}: {
  companyName: string;
  website?: string | null;
  logoUrl?: string | null;
  brandDomain?: string | null;
  rows: RankRow[];
  reportPath: string;
  showCta?: boolean;
}) {
  const ranked = [...rows]
    .map((r) => ({ ...r, pct: asPercent(r.share) }))
    .sort((a, b) => b.pct - a.pct);

  const yourIndex = ranked.findIndex((r) => r.isYou);
  const yourRank = yourIndex >= 0 ? yourIndex + 1 : ranked.length || 1;
  const top = ranked.slice(0, 8);
  const you =
    yourIndex >= 0
      ? ranked[yourIndex]
      : {
          name: companyName,
          pct: 0,
          isYou: true,
          logoUrl,
          domain: brandDomain,
          website,
        };

  const ordinal = (n: number) => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  return (
    <section className="grid gap-10 border border-zinc-800 bg-black px-5 py-8 lg:grid-cols-[1.1fr_0.9fr] lg:gap-14 lg:px-8 lg:py-10">
      <div className="flex flex-col justify-center">
        <div className="mb-5 flex items-center gap-2 text-sm text-zinc-300">
          <BrandLogo
            name={companyName}
            website={website}
            domain={brandDomain}
            logoUrl={logoUrl}
            size={22}
          />
          <span>
            {companyName} AEO Report
          </span>
        </div>
        <h2 className="font-sans text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          You rank {ordinal(yourRank)} in AI Visibility
        </h2>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-zinc-400">
          Read your AEO report below to understand and improve your brand&apos;s
          AI presence.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-4">
          {showCta && (
            <a
              href="/"
              className="inline-flex rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black transition hover:bg-zinc-200"
            >
              Try Cyted for free
            </a>
          )}
          <CopyReportLink reportPath={reportPath} />
        </div>
      </div>

      <div className="space-y-1">
        {top.map((r, i) => {
          const isYou = r.isYou || r.name === companyName;
          return (
            <div
              key={`${r.name}-${i}`}
              className={`flex items-center gap-3 px-1 py-2.5 text-sm ${
                isYou ? "rounded-xl border border-zinc-600 px-3" : ""
              }`}
            >
              <span className="w-5 tabular-nums text-zinc-500">{i + 1}</span>
              <BrandLogo
                name={r.name}
                domain={r.domain}
                website={r.website}
                logoUrl={r.logoUrl}
                size={28}
              />
              <span className="min-w-0 flex-1 truncate text-zinc-100">
                {r.name}
                {isYou && (
                  <span className="ml-2 inline-flex rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
                    Your brand
                  </span>
                )}
              </span>
              <span className="tabular-nums font-medium text-white">
                {r.pct.toFixed(1)}%
              </span>
              <span
                className="h-4 w-4 rounded-full border border-zinc-600"
                aria-hidden
              />
            </div>
          );
        })}

        {yourIndex >= 8 || yourIndex === -1 ? (
          <div className="mt-3 flex items-center gap-3 rounded-xl border border-zinc-600 px-3 py-3 text-sm">
            <span className="w-5 tabular-nums text-zinc-400">{yourRank}</span>
            <BrandLogo
              name={you.name}
              domain={you.domain}
              website={you.website}
              logoUrl={you.logoUrl}
              size={28}
            />
            <span className="min-w-0 flex-1 truncate text-white">
              {you.name}
              <span className="ml-2 inline-flex rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
                Your brand
              </span>
            </span>
            <span className="tabular-nums font-medium text-white">
              {you.pct.toFixed(1)}%
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
