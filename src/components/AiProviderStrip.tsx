"use client";

const PROVIDERS: Array<{
  id: string;
  label: string;
  // Simple recognizable marks via public SVG/CDN
  src: string;
}> = [
  {
    id: "openai",
    label: "ChatGPT",
    src: "https://cdn.simpleicons.org/openai/ffffff",
  },
  {
    id: "gemini",
    label: "Gemini",
    src: "https://cdn.simpleicons.org/googlegemini/8E75B2",
  },
  {
    id: "claude",
    label: "Claude",
    src: "https://cdn.simpleicons.org/anthropic/D4A27F",
  },
];

export function AiProviderStrip({
  providers,
  className = "",
}: {
  providers?: string[];
  className?: string;
}) {
  const active = providers?.length
    ? PROVIDERS.filter((p) =>
        providers.some((x) => x.toLowerCase().includes(p.id))
      )
    : PROVIDERS;

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
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.src}
              alt=""
              width={16}
              height={16}
              className="h-4 w-4"
              loading="lazy"
            />
            <span className="text-xs font-medium text-zinc-200">{p.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
