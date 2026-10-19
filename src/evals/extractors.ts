import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { estimateCallCostUsd } from "@/lib/ai-pricing";
import { createClaudeProvider } from "@/lib/providers/claude";
import { createGeminiProvider } from "@/lib/providers/gemini";
import { createGroqProvider } from "@/lib/providers/groq";
import { createOpenAIProvider } from "@/lib/providers/openai";
import type { LlmProvider } from "@/lib/providers/types";
import { brandMatches } from "@/lib/report-analytics";
import type { ExtractionInput } from "@/lib/services/extraction-prompt";

export type ExtractorOutput = {
  raw: string;
  latencyMs: number;
  /** Provider + model that produced the output, used for cost estimates. */
  provider: string;
  model: string;
};

export interface Extractor {
  id: string;
  kind: "llm" | "heuristic";
  /** Model id, or a version tag for non-LLM extractors. */
  model: string;
  run(input: ExtractionInput, prompt: { system: string; user: string }): Promise<ExtractorOutput>;
}

export type CacheMode = "live" | "record" | "replay";

export const LLM_EXTRACTOR_IDS = ["gemini", "openai", "claude", "groq"] as const;
export type LlmExtractorId = (typeof LLM_EXTRACTOR_IDS)[number];

/**
 * Build a provider straight from env keys. Deliberately bypasses getConfig()
 * and the DB-backed admin toggles so evals need no database or Supabase.
 */
function createProviderFromEnv(id: LlmExtractorId): LlmProvider {
  const env = process.env;
  const need = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`${key} is not set — required for the "${id}" extractor`);
    return value;
  };
  switch (id) {
    case "gemini":
      return createGeminiProvider(need("GEMINI_API_KEY"), env.GEMINI_MODEL || "gemini-2.0-flash");
    case "openai":
      return createOpenAIProvider(need("OPENAI_API_KEY"), env.OPENAI_MODEL || "gpt-4o");
    case "claude":
      return createClaudeProvider(
        need("ANTHROPIC_API_KEY"),
        env.CLAUDE_MODEL || "claude-sonnet-4-20250514"
      );
    case "groq":
      return createGroqProvider(
        need("GROQ_API_KEY"),
        env.GROQ_MODEL || "groq/compound",
        env.GROQ_COMPLETE_MODEL || "llama-3.3-70b-versatile"
      );
  }
}

function completeModelFor(id: LlmExtractorId, provider: LlmProvider): string {
  return id === "groq"
    ? process.env.GROQ_COMPLETE_MODEL || "llama-3.3-70b-versatile"
    : provider.model;
}

type CassetteEntry = {
  caseHint: string;
  model: string;
  raw: string;
  latencyMs: number;
  recordedAt: string;
};

/**
 * Record/replay cache for LLM outputs, keyed by a hash of the full prompt (the
 * model that produced each output is stored in the entry). Replay is strict:
 * any prompt change produces a cache miss, which fails the run instead of
 * silently scoring stale outputs.
 */
class Cassette {
  private entries: Record<string, CassetteEntry>;
  private dirty = false;

  constructor(private readonly file: string) {
    this.entries = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  }

  static key(prompt: { system: string; user: string }) {
    return createHash("sha256")
      .update(`${prompt.system}\n${prompt.user}`)
      .digest("hex")
      .slice(0, 24);
  }

  models(): string[] {
    return [...new Set(Object.values(this.entries).map((e) => e.model))];
  }

  get(key: string) {
    return this.entries[key];
  }

  set(key: string, entry: CassetteEntry) {
    this.entries[key] = entry;
    this.dirty = true;
  }

  save() {
    if (!this.dirty) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const sorted = Object.fromEntries(
      Object.entries(this.entries).sort(([a], [b]) => a.localeCompare(b))
    );
    writeFileSync(this.file, `${JSON.stringify(sorted, null, 2)}\n`);
  }
}

export function createLlmExtractor(
  id: LlmExtractorId,
  mode: CacheMode,
  cassetteDir: string
): Extractor & { flush(): void } {
  const cassette = new Cassette(path.join(cassetteDir, `${id}.json`));
  const provider = mode === "replay" ? null : createProviderFromEnv(id);
  const model = provider
    ? completeModelFor(id, provider)
    : cassette.models().join(", ") || "(no recordings)";

  return {
    id,
    kind: "llm",
    model,
    async run(input, prompt) {
      const key = Cassette.key(prompt);

      if (!provider) {
        const hit = cassette.get(key);
        if (!hit) {
          throw new Error(
            `No recorded ${id} output for this prompt — the prompt changed or the case is new. Re-record with --mode record.`
          );
        }
        return { raw: hit.raw, latencyMs: hit.latencyMs, provider: id, model: hit.model };
      }

      const started = Date.now();
      const raw = await provider.complete(prompt.system, prompt.user);
      const latencyMs = Date.now() - started;
      if (mode === "record") {
        cassette.set(key, {
          caseHint: input.companyName,
          model,
          raw,
          latencyMs,
          recordedAt: new Date().toISOString(),
        });
      }
      return { raw, latencyMs, provider: id, model };
    },
    flush: () => cassette.save(),
  };
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentions(text: string, brand: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(brand)}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

const POSITIVE_CUES = /\b(best|great|excellent|top|recommend\w*|lov(e|ed)|strong|generous|solid|flexible|lightweight|reliable|painless|winner|wins)\b/i;
const NEGATIVE_CUES = /\b(avoid\w*|outages?|slow|expensive|complex|upsells?|poor|bad|worse|unreliable|issues?)\b/i;

/** Ordered list items: numbered/bulleted lines (incl. inline "1. … 2. …"), else markdown table rows minus the header. */
function listItems(text: string): string[] {
  const lines = text
    .split("\n")
    .flatMap((line) => line.split(/\s(?=\d+[.)]\s)/))
    .map((l) => l.trim());
  const bullets = lines.filter((l) => /^(\d+[.)]|[-*•])\s/.test(l));
  if (bullets.length) return bullets;
  return lines
    .filter((l) => l.startsWith("|") && !/^\|[\s|:-]+\|?$/.test(l))
    .slice(1);
}

/**
 * Rule-based baseline: string matching for tracked brands, list position for
 * ranking, and a keyword lexicon for sentiment. It needs no API key, so CI can
 * run the full harness end to end, and it gives LLM extractors a floor to beat.
 */
export function createHeuristicExtractor(): Extractor {
  return {
    id: "heuristic",
    kind: "heuristic",
    model: "rules-v1",
    async run(input) {
      const started = Date.now();
      const text = input.rawResponse;
      const tracked = [input.companyName, ...input.competitors];
      const found = tracked.filter((b) => mentions(text, b));
      const companyHit = brandMatches(input.companyName, found);

      const items = listItems(text);
      const idx = items.findIndex((l) => mentions(l, input.companyName));
      const ranking = companyHit && idx >= 0 ? idx + 1 : null;

      let sentiment = "Neutral";
      if (companyHit) {
        const sentences = text
          .split(/(?<=[.!?])\s+|\n/)
          .filter((s) => mentions(s, input.companyName));
        const score = sentences.reduce(
          (a, s) => a + (POSITIVE_CUES.test(s) ? 1 : 0) - (NEGATIVE_CUES.test(s) ? 1 : 0),
          0
        );
        sentiment = score > 0 ? "Positive" : score < 0 ? "Negative" : "Neutral";
      }

      const raw = JSON.stringify({
        mentionedBrands: found,
        mentionedProducts: [],
        citations: text.match(/https?:\/\/\S+/g) ?? [],
        ranking,
        reasoning: "rule-based baseline",
        sentiment,
      });
      return { raw, latencyMs: Date.now() - started, provider: "heuristic", model: "rules-v1" };
    },
  };
}

export function estimateCost(output: ExtractorOutput, prompt: { system: string; user: string }) {
  if (output.provider === "heuristic") {
    return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
  const cost = estimateCallCostUsd({
    provider: output.provider,
    model: output.model,
    promptText: `${prompt.system}\n${prompt.user}`,
    responseText: output.raw,
  });
  return {
    inputTokens: cost.inputTokens,
    outputTokens: cost.outputTokens,
    costUsd: cost.totalCostUsd,
  };
}
