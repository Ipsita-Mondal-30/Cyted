"use client";

import { BrandLogo } from "@/components/BrandLogo";
import { guessDomainFromName } from "@/lib/brand-logo";

export const AI_PROVIDERS: Array<{
  id: string;
  label: string;
  domain: string;
  color: string;
}> = [
  { id: "openai", label: "ChatGPT", domain: "chatgpt.com", color: "#10a37f" },
  { id: "gemini", label: "Gemini", domain: "gemini.google.com", color: "#8e75b2" },
  { id: "claude", label: "Claude", domain: "claude.ai", color: "#d4a27f" },
  { id: "groq", label: "Groq", domain: "groq.com", color: "#f55036" },
];

export function providerMeta(provider: string) {
  const key = provider.toLowerCase();
  return (
    AI_PROVIDERS.find((p) => key.includes(p.id)) ?? {
      id: key,
      label: provider,
      domain: guessDomainFromName(provider),
      color: "#71717a",
    }
  );
}

export function AiProviderStrip({
  providers,
  className = "",
}: {
  providers?: string[];
  className?: string;
}) {
  const active = providers?.length
    ? AI_PROVIDERS.filter((p) =>
        providers.some((x) => providerMeta(x).id === p.id)
      )
    : AI_PROVIDERS;

  if (!active.length) return null;

  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
        Answer engines
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {active.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/80 px-3 py-1.5"
            title={p.label}
          >
            <BrandLogo name={p.label} domain={p.domain} size={16} />
            <span className="text-xs font-medium text-zinc-200">{p.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
