import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { getEnabledProviders, requireGemini } from "@/lib/providers/provider-manager";
import { mapWithConcurrency } from "@/lib/utils/concurrency";
import { withRetries } from "@/lib/utils/retries";

export type ExtractionPayload = {
  mentionedBrands: string[];
  mentionedProducts: string[];
  citations: string[];
  ranking: number | null;
  reasoning: string;
  sentiment: "Positive" | "Neutral" | "Negative" | string;
};

function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("No JSON object found in extraction response");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}

function getExtractor() {
  try {
    return requireGemini();
  } catch {
    return getEnabledProviders()[0];
  }
}

export async function extractFromResponses(
  analysisId: string,
  companyName: string,
  competitors: string[],
  onProgress?: (done: number, total: number) => Promise<void>
): Promise<void> {
  const responses = await prisma.response.findMany({
    where: { analysisId, error: null, rawResponse: { not: null } },
    select: { id: true, rawResponse: true },
  });

  const extractor = getExtractor();
  const maxRetries = getConfig().maxRetries;
  const concurrency = getConfig().concurrentRequests;
  let done = 0;
  const total = responses.length;

  await mapWithConcurrency(responses, concurrency, async (response) => {
    try {
      const payload = await withRetries(
        async () => {
          const raw = await extractor.complete(
            "Extract structured brand visibility data from AI assistant answers. Return JSON only.",
            `Company being analyzed: ${companyName}
Competitors: ${competitors.join(", ") || "none"}

AI assistant response:
"""
${response.rawResponse}
"""

Return JSON with:
{
  "mentionedBrands": ["brand names mentioned"],
  "mentionedProducts": ["product names mentioned"],
  "citations": ["urls or source names if any"],
  "ranking": <1-based position of ${companyName} if ranked/recommended, or null if not mentioned>,
  "reasoning": "brief explanation of how the company appears",
  "sentiment": "Positive" | "Neutral" | "Negative"
}`
          );
          const parsed = extractJson<ExtractionPayload>(raw);
          return {
            mentionedBrands: parsed.mentionedBrands || [],
            mentionedProducts: parsed.mentionedProducts || [],
            citations: parsed.citations || [],
            ranking: typeof parsed.ranking === "number" ? parsed.ranking : null,
            reasoning: parsed.reasoning || "",
            sentiment: parsed.sentiment || "Neutral",
          };
        },
        maxRetries,
        `extract:${response.id}`
      );

      await prisma.extractedResult.create({
        data: {
          responseId: response.id,
          mentionedBrands: payload.mentionedBrands,
          mentionedProducts: payload.mentionedProducts,
          citations: payload.citations,
          ranking: payload.ranking,
          reasoning: payload.reasoning,
          sentiment: payload.sentiment,
        },
      });
    } catch (error) {
      console.warn(
        `Extraction failed for response ${response.id}:`,
        error instanceof Error ? error.message : error
      );
    }

    done += 1;
    if (onProgress) {
      await onProgress(done, total);
    }
  });
}
