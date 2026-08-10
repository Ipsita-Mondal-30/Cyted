import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { getEnabledProviders } from "@/lib/providers/provider-manager";
import type { LlmProvider } from "@/lib/providers/types";
import { mapWithConcurrency } from "@/lib/utils/concurrency";

const log = createLogger("service:search");

type PromptRow = { id: string; prompt: string };

/**
 * Fan out prompt × provider searches in parallel.
 * Each provider runs its own pool (PER_PROVIDER_CONCURRENCY) so OpenAI,
 * Gemini, and Claude all progress at once instead of sharing one global queue.
 */
export async function searchAllProviders(
  analysisId: string,
  prompts: PromptRow[],
  onProgress?: (done: number, total: number) => Promise<void>
): Promise<void> {
  const providers = getEnabledProviders();
  const config = getConfig();
  const perProvider = Math.max(1, config.perProviderConcurrency);
  // Cap each pool so total in-flight ≈ searchConcurrency
  const poolSize = Math.max(
    1,
    Math.min(
      perProvider,
      Math.ceil(config.searchConcurrency / Math.max(providers.length, 1))
    )
  );

  const total = prompts.length * providers.length;
  log.info("Starting provider search (parallel)", {
    analysisId,
    prompts: prompts.length,
    providers: providers.map((p) => p.name),
    searchConcurrency: config.searchConcurrency,
    perProviderPool: poolSize,
    totalCalls: total,
  });

  let done = 0;

  async function runOne(provider: LlmProvider, prompt: PromptRow) {
    log.debug("Provider call start", {
      analysisId,
      provider: provider.name,
      promptId: prompt.id,
    });
    try {
      const result = await provider.search(prompt.prompt);
      await prisma.response.create({
        data: {
          analysisId,
          promptId: prompt.id,
          provider: result.provider,
          model: result.model,
          rawResponse: result.rawResponse,
          latencyMs: result.latencyMs,
        },
      });
      log.info("Provider call ok", {
        analysisId,
        provider: result.provider,
        latencyMs: result.latencyMs,
        chars: result.rawResponse.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("Provider call failed — continuing", {
        analysisId,
        provider: provider.name,
        error: message,
      });
      await prisma.response.create({
        data: {
          analysisId,
          promptId: prompt.id,
          provider: provider.name,
          model: provider.model,
          rawResponse: null,
          latencyMs: null,
          error: message,
        },
      });
    }

    done += 1;
    if (onProgress) {
      await onProgress(done, total);
    }
  }

  // All providers progress concurrently; each has its own concurrency pool
  await Promise.all(
    providers.map((provider) =>
      mapWithConcurrency(prompts, poolSize, async (prompt) => {
        await runOne(provider, prompt);
      })
    )
  );

  log.info("Provider search finished", { analysisId, total });
}
