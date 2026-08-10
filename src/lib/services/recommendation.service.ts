import { prisma } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { completePreferringGemini } from "@/lib/providers/provider-manager";

const log = createLogger("service:recommendation");

export type ContentSuggestion = {
  type: string;
  title: string;
  description: string;
};

export type RecommendationPayload = {
  markdown: string;
  contentSuggestions: ContentSuggestion[];
};

function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

/**
 * LLMs often emit invalid JSON with literal newlines inside the markdown string.
 * Extract the markdown field with a small scanner that tolerates that.
 */
function extractMarkdownFieldLenient(text: string): string | null {
  const key = '"markdown"';
  const keyIdx = text.indexOf(key);
  if (keyIdx === -1) return null;

  let i = keyIdx + key.length;
  while (i < text.length && /[\s:]/.test(text[i]!)) i++;
  if (text[i] !== '"') return null;
  i++;

  let out = "";
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") {
      const n = text[i + 1];
      if (n === "n") out += "\n";
      else if (n === "r") out += "\r";
      else if (n === "t") out += "\t";
      else if (n === '"' || n === "\\") out += n;
      else if (n) out += n;
      i += 2;
      continue;
    }
    if (c === '"') {
      // End of string if followed by , or } (allowing whitespace)
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (j >= text.length || text[j] === "," || text[j] === "}") {
        return out;
      }
      // Otherwise treat as literal quote inside broken JSON
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out || null;
}

function extractSuggestionsLenient(text: string): ContentSuggestion[] {
  const parsed = tryParseJson(text);
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as RecommendationPayload).contentSuggestions)
  ) {
    return ((parsed as RecommendationPayload).contentSuggestions || []).filter(
      (s) => s?.title && s?.description && s?.type
    );
  }

  const marker = '"contentSuggestions"';
  const idx = text.indexOf(marker);
  if (idx === -1) return [];
  const arrStart = text.indexOf("[", idx);
  if (arrStart === -1) return [];
  let depth = 0;
  let end = -1;
  for (let i = arrStart; i < text.length; i++) {
    if (text[i] === "[") depth++;
    if (text[i] === "]") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];
  try {
    const arr = JSON.parse(text.slice(arrStart, end + 1)) as ContentSuggestion[];
    return Array.isArray(arr)
      ? arr.filter((s) => s?.title && s?.description && s?.type)
      : [];
  } catch {
    return [];
  }
}

function looksLikeWrappedJson(text: string): boolean {
  const t = text.trim();
  return t.startsWith("{") && t.includes('"markdown"');
}

/**
 * Parse stored recommendation content into renderable markdown + suggestions.
 * Handles: proper JSON payload, nested JSON-as-markdown, and broken LLM JSON.
 */
export function parseRecommendationContent(
  content: string
): RecommendationPayload {
  if (!content?.trim()) {
    return { markdown: "", contentSuggestions: [] };
  }

  let markdown = content;
  let contentSuggestions: ContentSuggestion[] = [];

  // Unwrap up to 3 levels of { markdown: "..." } wrappers
  for (let depth = 0; depth < 3; depth++) {
    const parsed = tryParseJson(markdown);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as RecommendationPayload).markdown === "string"
    ) {
      const p = parsed as RecommendationPayload;
      markdown = p.markdown;
      if (Array.isArray(p.contentSuggestions) && p.contentSuggestions.length) {
        contentSuggestions = p.contentSuggestions.filter(
          (s) => s?.title && s?.description && s?.type
        );
      }
      if (!looksLikeWrappedJson(markdown)) break;
      continue;
    }

    if (looksLikeWrappedJson(markdown)) {
      const extracted = extractMarkdownFieldLenient(markdown);
      if (extracted) {
        if (!contentSuggestions.length) {
          contentSuggestions = extractSuggestionsLenient(markdown);
        }
        markdown = extracted;
        if (!looksLikeWrappedJson(markdown)) break;
        continue;
      }
    }
    break;
  }

  // Strip accidental fences around the final markdown
  markdown = markdown
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  return { markdown, contentSuggestions };
}

function parseGeneratedRecommendation(
  text: string,
  companyName: string
): RecommendationPayload {
  // Prefer delimiter format
  const mdPart = text.match(
    /===MARKDOWN===\s*([\s\S]*?)(?:===SUGGESTIONS===|$)/i
  );
  const sugPart = text.match(/===SUGGESTIONS===\s*([\s\S]*?)$/i);

  if (mdPart?.[1]?.trim()) {
    let suggestions: ContentSuggestion[] = [];
    if (sugPart?.[1]) {
      const parsed = tryParseJson(sugPart[1].trim());
      if (Array.isArray(parsed)) {
        suggestions = (parsed as ContentSuggestion[]).filter(
          (s) => s?.title && s?.description && s?.type
        );
      } else if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { suggestions?: unknown }).suggestions)
      ) {
        suggestions = (
          (parsed as { suggestions: ContentSuggestion[] }).suggestions || []
        ).filter((s) => s?.title && s?.description && s?.type);
      }
    }
    return {
      markdown: mdPart[1].trim(),
      contentSuggestions: suggestions,
    };
  }

  // Fallback: JSON / lenient extract
  const parsed = parseRecommendationContent(text);
  if (parsed.markdown && !looksLikeWrappedJson(parsed.markdown)) {
    return parsed;
  }

  const extracted = extractMarkdownFieldLenient(text);
  if (extracted) {
    return {
      markdown: extracted,
      contentSuggestions: extractSuggestionsLenient(text),
    };
  }

  // Last resort: treat whole reply as markdown if it has headings
  if (text.includes("#")) {
    return {
      markdown: text.replace(/^[\s\S]*?(#\s)/, "$1").trim(),
      contentSuggestions: [],
    };
  }

  return {
    markdown: `# AI Visibility Report for ${companyName}\n\n${text}`,
    contentSuggestions: [],
  };
}

export async function generateAndStoreRecommendations(
  analysisId: string,
  companyName: string,
  competitors: string[]
): Promise<{ ok: boolean; warning?: string }> {
  const metrics = await prisma.metrics.findUnique({ where: { analysisId } });
  if (!metrics) {
    return { ok: false, warning: "Recommendations skipped: metrics missing" };
  }

  const prompts = await prisma.prompt.findMany({
    where: { analysisId },
    select: { category: true },
  });
  const categories = [...new Set(prompts.map((p) => p.category))];

  const competitorShare = Object.fromEntries(
    Object.entries(
      (metrics.competitorShare as Record<string, number>) || {}
    ).filter(([k]) => !k.startsWith("__"))
  );

  try {
    log.info("Generating recommendations", { analysisId, companyName });
    const { text, provider, model } = await completePreferringGemini(
      `You are an AI visibility / GEO consultant.
Return the report using the exact delimiters below — do NOT wrap the whole reply in JSON.`,
      `Generate an AI visibility improvement plan for "${companyName}".

Metrics:
- Visibility Score: ${metrics.visibilityScore}
- Mention Rate: ${metrics.mentionRate}%
- Share of Voice: ${metrics.shareOfVoice}%
- Citation Rate: ${metrics.citationRate}%
- Recommendation Rate: ${metrics.recommendationRate}%
- Average Ranking: ${metrics.avgRanking ?? "N/A"}
- Competitor Share: ${JSON.stringify(competitorShare)}
- Competitors: ${competitors.join(", ") || "none"}
- Prompt categories: ${categories.join(", ")}

Output format (exact):

===MARKDOWN===
# ${companyName} — AI Visibility Report

(Write a full markdown report with ## headings, **bold**, bullets, numbered lists, and tables if useful.)
Include: Summary snapshot, prioritization timeline, Content strategy, SEO/GEO, Schema markup, Comparison pages, FAQ, Buying guides, Review/social proof. Be specific to the metrics above.

===SUGGESTIONS===
[
  {"type":"Listicle","title":"...","description":"..."},
  {"type":"Problem Solution","title":"...","description":"..."},
  {"type":"Year Specific","title":"...","description":"..."},
  {"type":"Comparison","title":"...","description":"..."},
  {"type":"How-To","title":"...","description":"..."},
  {"type":"FAQ Hub","title":"...","description":"..."}
]

Provide 5-8 suggestions. Types may also include Buying Guide or Case Study.`
    );

    const payload = parseGeneratedRecommendation(text, companyName);
    const content = JSON.stringify(payload);

    await prisma.recommendation.upsert({
      where: { analysisId },
      create: { analysisId, content },
      update: { content },
    });

    log.info("Recommendations saved", {
      analysisId,
      provider,
      model,
      chars: content.length,
      markdownChars: payload.markdown.length,
      suggestions: payload.contentSuggestions.length,
    });
    return { ok: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Recommendation generation failed";
    log.warn("Recommendations failed (soft)", { analysisId, error: message });
    return { ok: false, warning: message };
  }
}
