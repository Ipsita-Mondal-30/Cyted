import { prisma } from "@/lib/db";

function brandMatches(name: string, brands: string[]): boolean {
  const target = name.toLowerCase().trim();
  if (!target) return false;
  return brands.some((b) => {
    const brand = b.toLowerCase().trim();
    return brand === target || brand.includes(target) || target.includes(brand);
  });
}

export async function calculateAndStoreMetrics(
  analysisId: string,
  companyName: string,
  competitors: string[]
) {
  const extractions = await prisma.extractedResult.findMany({
    where: { response: { analysisId } },
    include: { response: { select: { id: true, promptId: true } } },
  });

  const total = extractions.length;
  if (total === 0) {
    await prisma.metrics.create({
      data: {
        analysisId,
        visibilityScore: 0,
        mentionRate: 0,
        shareOfVoice: 0,
        citationRate: 0,
        recommendationRate: 0,
        avgRanking: null,
        competitorShare: {},
      },
    });
    return;
  }

  let companyMentions = 0;
  let citationHits = 0;
  let recommendationHits = 0;
  const rankings: number[] = [];
  const brandCounts: Record<string, number> = { [companyName]: 0 };
  for (const c of competitors) brandCounts[c] = 0;

  // Mention rate by unique prompt: company mentioned in any extraction for that prompt
  const promptsMentioned = new Set<string>();
  const allPromptIds = new Set<string>();

  for (const row of extractions) {
    const brands = (row.mentionedBrands as string[]) || [];
    const citations = (row.citations as string[]) || [];
    allPromptIds.add(row.response.promptId);

    const companyHit = brandMatches(companyName, brands);
    if (companyHit) {
      companyMentions += 1;
      brandCounts[companyName] += 1;
      promptsMentioned.add(row.response.promptId);
    }

    for (const competitor of competitors) {
      if (brandMatches(competitor, brands)) {
        brandCounts[competitor] += 1;
      }
    }

    if (citations.length > 0 && companyHit) {
      citationHits += 1;
    }

    if (row.ranking != null && row.ranking > 0) {
      rankings.push(row.ranking);
    }

    const sentiment = (row.sentiment || "").toLowerCase();
    const isRecommended =
      companyHit &&
      (sentiment === "positive" || (row.ranking != null && row.ranking <= 3));
    if (isRecommended) {
      recommendationHits += 1;
    }
  }

  const mentionRate =
    allPromptIds.size > 0 ? promptsMentioned.size / allPromptIds.size : 0;

  const totalBrandMentions = Object.values(brandCounts).reduce(
    (a, b) => a + b,
    0
  );
  const shareOfVoice =
    totalBrandMentions > 0 ? brandCounts[companyName] / totalBrandMentions : 0;

  const citationRate = companyMentions > 0 ? citationHits / companyMentions : 0;
  const recommendationRate = total > 0 ? recommendationHits / total : 0;
  const avgRanking =
    rankings.length > 0
      ? rankings.reduce((a, b) => a + b, 0) / rankings.length
      : null;

  // Visibility: weighted blend of mention, SoV, recommendation, citation
  const rankingScore =
    avgRanking == null ? 0 : Math.max(0, 1 - (avgRanking - 1) / 10);
  const visibilityScore =
    mentionRate * 0.35 +
    shareOfVoice * 0.25 +
    recommendationRate * 0.25 +
    citationRate * 0.1 +
    rankingScore * 0.05;

  const competitorShare: Record<string, number> = {};
  for (const [brand, count] of Object.entries(brandCounts)) {
    competitorShare[brand] =
      totalBrandMentions > 0 ? count / totalBrandMentions : 0;
  }

  await prisma.metrics.upsert({
    where: { analysisId },
    create: {
      analysisId,
      visibilityScore: round4(visibilityScore * 100),
      mentionRate: round4(mentionRate * 100),
      shareOfVoice: round4(shareOfVoice * 100),
      citationRate: round4(citationRate * 100),
      recommendationRate: round4(recommendationRate * 100),
      avgRanking: avgRanking != null ? round4(avgRanking) : null,
      competitorShare,
    },
    update: {
      visibilityScore: round4(visibilityScore * 100),
      mentionRate: round4(mentionRate * 100),
      shareOfVoice: round4(shareOfVoice * 100),
      citationRate: round4(citationRate * 100),
      recommendationRate: round4(recommendationRate * 100),
      avgRanking: avgRanking != null ? round4(avgRanking) : null,
      competitorShare,
    },
  });
}

function round4(n: number) {
  return Math.round(n * 10000) / 10000;
}
