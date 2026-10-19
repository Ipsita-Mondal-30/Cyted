import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import {
  completePreferringGemini,
} from "@/lib/providers/provider-manager";
import {
  buildExtractionPrompt,
  parseExtraction,
} from "@/lib/services/extraction-prompt";
import { mapWithConcurrency } from "@/lib/utils/concurrency";
import { withRetries } from "@/lib/utils/retries";

const log = createLogger("service:extraction");

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

  const maxRetries = getConfig().maxRetries;
  const concurrency = getConfig().extractConcurrency;
  log.info("Starting extraction", {
    analysisId,
    responses: responses.length,
    concurrency,
    maxRetries,
  });
  let done = 0;
  const total = responses.length;
  let successCount = 0;
  let failCount = 0;

  await mapWithConcurrency(responses, concurrency, async (response) => {
    try {
      const payload = await withRetries(
        async () => {
          const { system, user } = buildExtractionPrompt({
            companyName,
            competitors,
            rawResponse: response.rawResponse || "",
          });
          const { text: raw, provider } = await completePreferringGemini(system, user);
          const { payload, schemaIssues } = parseExtraction(raw);
          log.debug("Extraction LLM ok", {
            responseId: response.id,
            provider,
            schemaIssues,
          });
          return payload;
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
      successCount += 1;
      log.debug("Extraction ok", {
        responseId: response.id,
        brands: payload.mentionedBrands.length,
        ranking: payload.ranking,
        sentiment: payload.sentiment,
      });
    } catch (error) {
      failCount += 1;
      log.warn(`Extraction failed for response ${response.id}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    done += 1;
    if (onProgress) {
      await onProgress(done, total);
    }
  });

  log.info("Extraction finished", { analysisId, successCount, failCount, total });
}
