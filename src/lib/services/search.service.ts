import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { getEnabledProviders } from "@/lib/providers/provider-manager";
import { mapWithConcurrency } from "@/lib/utils/concurrency";

const log = createLogger("service:search");

type PromptRow = { id: string; prompt: string };

export async function searchAllProviders(
  analysisId: string,
  prompts: PromptRow[],
  onProgress?: (done: number, total: number) => Promise<void>
): Promise<void> {
  const providers = getEnabledProviders();
  const concurrency = getConfig().concurrentRequests;
  log.info("Starting provider search", {
    analysisId,
    prompts: prompts.length,
    providers: providers.map((p) => p.name),
    concurrency,
  });

  type Task = { prompt: PromptRow; providerIndex: number };
  const tasks: Task[] = [];
  for (const prompt of prompts) {
    for (let i = 0; i < providers.length; i++) {
      tasks.push({ prompt, providerIndex: i });
    }
  }

  let done = 0;
  const total = tasks.length;

  await mapWithConcurrency(tasks, concurrency, async (task) => {
    const provider = providers[task.providerIndex];
    log.debug("Provider call start", {
      analysisId,
      provider: provider.name,
      promptId: task.prompt.id,
    });
    try {
      const result = await provider.search(task.prompt.prompt);
      await prisma.response.create({
        data: {
          analysisId,
          promptId: task.prompt.id,
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
          promptId: task.prompt.id,
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
  });

  log.info("Provider search finished", { analysisId, total });
}
