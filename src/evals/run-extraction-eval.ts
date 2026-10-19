/**
 * Extraction eval harness.
 *
 *   npm run eval                                   # offline: rule-based baseline + any recorded LLM outputs
 *   npm run eval -- --extractors gemini --mode record   # call Gemini and save outputs to evals/cassettes
 *   npm run eval -- --extractors heuristic,gemini --mode replay --gate
 *
 * Runs the production extraction prompt + parser over the golden dataset,
 * scores every extractor, writes a report to evals/reports, and with --gate
 * exits non-zero when a metric falls below evals/thresholds.json.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  buildExtractionPrompt,
  EXTRACTION_PROMPT_VERSION,
  parseExtraction,
} from "@/lib/services/extraction-prompt";
import { mapWithConcurrency } from "@/lib/utils/concurrency";
import { withRetries } from "@/lib/utils/retries";
import {
  createHeuristicExtractor,
  createLlmExtractor,
  estimateCost,
  LLM_EXTRACTOR_IDS,
  type CacheMode,
  type Extractor,
  type LlmExtractorId,
} from "./extractors";
import {
  checkThresholds,
  scoreCase,
  SENTIMENTS,
  summarize,
  type CaseRun,
  type CaseScore,
  type EvalSummary,
  type GoldenDataset,
  type Thresholds,
} from "./scorers";

const { values: args } = parseArgs({
  options: {
    extractors: { type: "string", default: "heuristic" },
    mode: { type: "string", default: "replay" },
    dataset: { type: "string", default: "evals/datasets/extraction.golden.json" },
    thresholds: { type: "string", default: "evals/thresholds.json" },
    cassettes: { type: "string", default: "evals/cassettes" },
    out: { type: "string", default: "evals/reports" },
    tag: { type: "string" },
    concurrency: { type: "string", default: "3" },
    gate: { type: "boolean", default: false },
  },
});

type ExtractorResult = {
  extractor: Pick<Extractor, "id" | "kind" | "model">;
  summary: EvalSummary;
  scores: CaseScore[];
  thresholdFailures: string[];
};

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

function gitCommit() {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

function buildExtractors(ids: string[], mode: CacheMode): Array<Extractor & { flush?: () => void }> {
  return ids.map((id) => {
    if (id === "heuristic") return createHeuristicExtractor();
    if ((LLM_EXTRACTOR_IDS as readonly string[]).includes(id)) {
      return createLlmExtractor(id as LlmExtractorId, mode, args.cassettes!);
    }
    throw new Error(
      `Unknown extractor "${id}". Use: heuristic, ${LLM_EXTRACTOR_IDS.join(", ")}`
    );
  });
}

async function runExtractor(
  extractor: Extractor,
  dataset: GoldenDataset,
  mode: CacheMode
): Promise<{ runs: CaseRun[]; scores: CaseScore[] }> {
  const runs = await mapWithConcurrency(
    dataset.cases,
    Number(args.concurrency) || 3,
    async (golden): Promise<CaseRun> => {
      const input = {
        companyName: golden.companyName,
        competitors: golden.competitors,
        rawResponse: golden.response,
      };
      const prompt = buildExtractionPrompt(input);
      const base = { caseId: golden.id, tags: golden.tags };
      let output;
      try {
        output = await withRetries(
          () => extractor.run(input, prompt),
          extractor.kind === "llm" && mode !== "replay" ? 2 : 0,
          `eval:${extractor.id}:${golden.id}`
        );
      } catch (error) {
        return {
          ...base,
          prediction: null,
          schemaIssues: [],
          error: error instanceof Error ? error.message : String(error),
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        };
      }
      const cost = estimateCost(output, prompt);
      try {
        const { payload, schemaIssues } = parseExtraction(output.raw);
        return { ...base, prediction: payload, schemaIssues, latencyMs: output.latencyMs, ...cost };
      } catch (error) {
        return {
          ...base,
          prediction: null,
          schemaIssues: [],
          error: `parse failed: ${error instanceof Error ? error.message : String(error)}`,
          latencyMs: output.latencyMs,
          ...cost,
        };
      }
    }
  );
  const byId = new Map(dataset.cases.map((c) => [c.id, c]));
  return { runs, scores: runs.map((r) => scoreCase(byId.get(r.caseId)!, r)) };
}

function tagBreakdown(scores: CaseScore[]) {
  const tags = [...new Set(scores.flatMap((s) => s.tags))].sort();
  return tags.map((tag) => {
    const subset = scores.filter((s) => s.tags.includes(tag));
    const rate = (f: (s: CaseScore) => boolean) => subset.filter(f).length / subset.length;
    return {
      tag,
      cases: subset.length,
      mention: rate((s) => s.mentionCorrect),
      ranking: rate((s) => s.rankingExact),
      sentiment: rate((s) => s.sentimentCorrect),
      fullyCorrect: rate((s) => s.failures.length === 0),
    };
  });
}

function renderMarkdown(
  results: ExtractorResult[],
  meta: Record<string, string | number>
): string {
  const lines: string[] = [];
  lines.push(`# Extraction eval report`, "");
  lines.push(
    Object.entries(meta)
      .map(([k, v]) => `- **${k}:** ${v}`)
      .join("\n"),
    ""
  );

  lines.push("## Summary", "");
  lines.push(
    "| Extractor | Model | Parse | Schema | Mention acc | Brand P / R / F1 | Ranking exact | Rank MAE | Sentiment | Recommended | p50 / p95 latency | Est. cost | Gate |"
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const s = r.summary;
    lines.push(
      `| ${r.extractor.id} | ${r.extractor.model} | ${pct(s.parseRate)} | ${pct(s.schemaValidity)} | ${pct(s.mentionAccuracy)} | ${pct(s.trackedBrandPrecision)} / ${pct(s.trackedBrandRecall)} / ${pct(s.trackedBrandF1)} | ${pct(s.rankingExact)} | ${s.rankingMae == null ? "–" : s.rankingMae.toFixed(2)} | ${pct(s.sentimentAccuracy)} | ${pct(s.recommendedAccuracy)} | ${s.latencyP50Ms} / ${s.latencyP95Ms} ms | $${s.totalCostUsd.toFixed(5)} | ${r.thresholdFailures.length ? "❌" : "✅"} |`
    );
  }
  lines.push("");

  for (const r of results) {
    lines.push(`## ${r.extractor.id}`, "");
    if (r.thresholdFailures.length) {
      lines.push("**Below threshold:**", ...r.thresholdFailures.map((f) => `- ${f}`), "");
    }

    lines.push("### By tag", "", "| Tag | Cases | Mention | Ranking | Sentiment | Fully correct |", "|---|---|---|---|---|---|");
    for (const t of tagBreakdown(r.scores)) {
      lines.push(`| ${t.tag} | ${t.cases} | ${pct(t.mention)} | ${pct(t.ranking)} | ${pct(t.sentiment)} | ${pct(t.fullyCorrect)} |`);
    }
    lines.push("");

    lines.push("### Sentiment confusion (rows = expected)", "");
    lines.push(`| | ${[...SENTIMENTS, "Unparsed"].join(" | ")} |`, `|---|${"---|".repeat(SENTIMENTS.length + 1)}`);
    for (const e of SENTIMENTS) {
      const row = r.summary.sentimentConfusion[e];
      lines.push(`| **${e}** | ${[...SENTIMENTS, "Unparsed" as const].map((p) => row[p]).join(" | ")} |`);
    }
    lines.push("");

    const failing = r.scores.filter((s) => s.failures.length);
    lines.push(`### Failing cases (${failing.length}/${r.scores.length})`, "");
    if (!failing.length) lines.push("None.");
    for (const s of failing) {
      lines.push(`- **${s.caseId}** (${s.tags.join(", ")}): ${s.failures.join("; ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  const mode = args.mode as CacheMode;
  if (!["live", "record", "replay"].includes(mode)) {
    throw new Error(`--mode must be live, record or replay (got "${args.mode}")`);
  }

  const datasetText = readFileSync(args.dataset!, "utf8");
  const dataset = JSON.parse(datasetText) as GoldenDataset;
  if (args.tag) dataset.cases = dataset.cases.filter((c) => c.tags.includes(args.tag!));
  if (!dataset.cases.length) throw new Error("No cases to run");

  const thresholds = JSON.parse(readFileSync(args.thresholds!, "utf8")) as Record<
    Extractor["kind"],
    Thresholds
  >;

  const extractors = buildExtractors(
    args.extractors!.split(",").map((s) => s.trim()).filter(Boolean),
    mode
  );

  const results: ExtractorResult[] = [];
  for (const extractor of extractors) {
    console.log(`▶ ${extractor.id} (${extractor.model}) — ${dataset.cases.length} cases, mode=${mode}`);
    const { runs, scores } = await runExtractor(extractor, dataset, mode);
    extractor.flush?.();
    const summary = summarize(scores, runs);
    results.push({
      extractor: { id: extractor.id, kind: extractor.kind, model: extractor.model },
      summary,
      scores,
      thresholdFailures: checkThresholds(summary, thresholds[extractor.kind] ?? {}),
    });
  }

  console.table(
    Object.fromEntries(
      results.map((r) => [
        r.extractor.id,
        {
          parse: pct(r.summary.parseRate),
          mention: pct(r.summary.mentionAccuracy),
          brandF1: pct(r.summary.trackedBrandF1),
          ranking: pct(r.summary.rankingExact),
          sentiment: pct(r.summary.sentimentAccuracy),
          recommended: pct(r.summary.recommendedAccuracy),
          costUsd: r.summary.totalCostUsd.toFixed(5),
          gate: r.thresholdFailures.length ? "FAIL" : "pass",
        },
      ])
    )
  );

  const meta = {
    generated: new Date().toISOString(),
    commit: gitCommit(),
    prompt: EXTRACTION_PROMPT_VERSION,
    dataset: `${dataset.name} v${dataset.version} (${dataset.cases.length} cases, sha ${createHash("sha256").update(datasetText).digest("hex").slice(0, 10)})`,
    mode,
  };
  mkdirSync(args.out!, { recursive: true });
  const stamp = meta.generated.replace(/[:.]/g, "-");
  const markdown = renderMarkdown(results, meta);
  const json = JSON.stringify({ meta, results }, null, 2);
  for (const name of [`extraction-${stamp}`, "latest"]) {
    writeFileSync(path.join(args.out!, `${name}.md`), markdown);
    writeFileSync(path.join(args.out!, `${name}.json`), json);
  }
  console.log(`Report: ${path.join(args.out!, "latest.md")}`);

  const failed = results.filter((r) => r.thresholdFailures.length);
  for (const r of failed) {
    console.error(`✖ ${r.extractor.id}: ${r.thresholdFailures.join("; ")}`);
  }
  if (args.gate && failed.length) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
