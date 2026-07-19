import { prisma } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { completePreferringGemini } from "@/lib/providers/provider-manager";

const log = createLogger("service:recommendation");

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
    const { text: content, provider, model } = await completePreferringGemini(
      "You are an AI visibility / GEO (Generative Engine Optimization) consultant. Write clear, actionable recommendations.",
      `Generate recommendations for improving AI visibility for "${companyName}".

Metrics:
- Visibility Score: ${metrics.visibilityScore}
- Mention Rate: ${metrics.mentionRate}%
- Share of Voice: ${metrics.shareOfVoice}%
- Citation Rate: ${metrics.citationRate}%
- Recommendation Rate: ${metrics.recommendationRate}%
- Average Ranking: ${metrics.avgRanking ?? "N/A"}
- Competitor Share: ${JSON.stringify(metrics.competitorShare)}
- Competitors: ${competitors.join(", ") || "none"}
- Prompt categories covered: ${categories.join(", ")}

Include concrete advice on:
1. Content strategy
2. SEO / GEO
3. Schema markup
4. Comparison pages
5. FAQ pages
6. Buying guides
7. Review / social proof pages

Write a structured markdown report. Be specific to this brand and metrics.`
    );

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
    });
    return { ok: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Recommendation generation failed";
    log.warn("Recommendations failed (soft)", { analysisId, error: message });
    return { ok: false, warning: message };
  }
}
