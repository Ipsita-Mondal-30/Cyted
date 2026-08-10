"use client";

import type { ContentSuggestion } from "@/lib/services/recommendation.service";

const TYPE_ICON: Record<string, string> = {
  Listicle: "☰",
  "Problem Solution": "◈",
  "Year Specific": "◷",
  Comparison: "⇄",
  "How-To": "↳",
  "FAQ Hub": "?",
  "Buying Guide": "$",
  "Case Study": "▣",
};

export function ContentSuggestions({
  suggestions,
}: {
  suggestions: ContentSuggestion[];
}) {
  if (!suggestions.length) return null;

  return (
    <section className="border border-zinc-800 bg-zinc-950/60">
      <div className="border-b border-zinc-800 px-5 py-5">
        <h2 className="text-2xl font-semibold tracking-tight text-white">
          Content suggestions
        </h2>
        <p className="mt-2 text-sm text-zinc-400">
          Generated content ideas to boost AEO, based on citation and mention
          patterns from your prompts.
        </p>
      </div>
      <ul className="divide-y divide-zinc-800">
        {suggestions.map((s, idx) => (
          <li
            key={`${s.type}-${s.title}-${idx}`}
            className="flex gap-4 px-5 py-5"
          >
            <div className="flex h-12 w-10 shrink-0 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 text-sm text-zinc-300">
              {TYPE_ICON[s.type] || "📄"}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-white">{s.title}</h3>
                <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                  {s.type}
                </span>
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
                {s.description}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
