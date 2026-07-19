import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { getEnabledProviders } from "@/lib/providers/provider-manager";
import { mapWithConcurrency } from "@/lib/utils/concurrency";

type PromptRow = { id: string; prompt: string };

export async function searchAllProviders(
  analysisId: string,
  prompts: PromptRow[],
  onProgress?: (done: number, total: number) => Promise<void>
): Promise<void> {
  const providers = getEnabledProviders();
  const concurrency = getConfig().concurrentRequests;

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
    } catch (error) {
      await prisma.response.create({
        data: {
          analysisId,
          promptId: task.prompt.id,
          provider: provider.name,
          model: provider.model,
          rawResponse: null,
          latencyMs: null,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }

    done += 1;
    if (onProgress) {
      await onProgress(done, total);
    }
  });
}
