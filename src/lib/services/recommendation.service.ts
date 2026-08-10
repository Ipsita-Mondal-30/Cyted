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

function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("No JSON object found in recommendation response");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}

export function parseRecommendationContent(
  content: string
): RecommendationPayload {
  try {
    const parsed = JSON.parse(content) as Partial<RecommendationPayload>;
    if (parsed && typeof parsed.markdown === "string") {
      return {
        markdown: parsed.markdown,
        contentSuggestions: Array.isArray(parsed.contentSuggestions)
          ? parsed.contentSuggestions
          : [],
      };
    }
  } catch {
    // legacy plain markdown
  }
  return { markdown: content, contentSuggestions: [] };
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

  try {
    log.info("Generating recommendations", { analysisId, companyName });
    const { text, provider, model } = await completePreferringGemini(
      "You are an AI visibility / GEO consultant. Return JSON only with markdown report and content suggestions.",
      `Generate an AI visibility improvement plan for "${companyName}".

Metrics:
- Visibility Score: ${metrics.visibilityScore}
- Mention Rate: ${metrics.mentionRate}%
- Share of Voice: ${metrics.shareOfVoice}%
- Citation Rate: ${metrics.citationRate}%
- Recommendation Rate: ${metrics.recommendationRate}%
- Average Ranking: ${metrics.avgRanking ?? "N/A"}
- Competitor Share: ${JSON.stringify(
  Object.fromEntries(
    Object.entries(
      (metrics.competitorShare as Record<string, number>) || {}
    ).filter(([k]) => !k.startsWith("__"))
  )
)}
- Competitors: ${competitors.join(", ") || "none"}
- Prompt categories: ${categories.join(", ")}

Return JSON ONLY (no markdown fences) with this shape:
{
  "markdown": "# Workpunkt — AI Visibility Report\\n\\nUse proper markdown: # ## ###, **bold**, - bullets, numbered lists, tables if useful. Include Summary snapshot, prioritization timeline, then sections for Content strategy, SEO/GEO, Schema markup, Comparison pages, FAQ pages, Buying guides, Review/social proof. Be specific to these metrics.",
  "contentSuggestions": [
    {
      "type": "Listicle",
      "title": "Concrete article title",
      "description": "1-2 sentences on why this boosts AEO/citations"
    }
  ]
}

Provide 5-8 contentSuggestions with varied types such as Listicle, Problem Solution, Year Specific, Comparison, How-To, FAQ Hub, Buying Guide, Case Study.`
    );

    let payload: RecommendationPayload;
    try {
      const parsed = extractJson<{
        markdown?: string;
        contentSuggestions?: ContentSuggestion[];
      }>(text);
      payload = {
        markdown:
          parsed.markdown ||
          `# AI Visibility Report for ${companyName}\n\n${text}`,
        contentSuggestions: Array.isArray(parsed.contentSuggestions)
          ? parsed.contentSuggestions.filter(
              (s) => s?.title && s?.description && s?.type
            )
          : [],
      };
    } catch {
      payload = {
        markdown: text,
        contentSuggestions: [],
      };
    }

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
