import { getConfig } from "@/lib/config";
import { createLogger } from "@/lib/logger";
import { createClaudeProvider } from "./claude";
import { createGeminiProvider } from "./gemini";
import { createOpenAIProvider } from "./openai";
import type { LlmProvider, ProviderName } from "./types";

const log = createLogger("providers");

/**
 * Build the enabled provider list from current config every time.
 * Do not cache across jobs — otherwise adding ANTHROPIC_API_KEY mid-process
 * (or restarting with a new .env) would keep the old openai+gemini-only set.
 */
export function getEnabledProviders(): LlmProvider[] {
  const config = getConfig();
  const providers: LlmProvider[] = [];

  if (config.openaiApiKey) {
    providers.push(createOpenAIProvider(config.openaiApiKey, config.openaiModel));
  }
  if (config.geminiApiKey) {
    providers.push(createGeminiProvider(config.geminiApiKey, config.geminiModel));
  }
  if (config.anthropicApiKey) {
    providers.push(createClaudeProvider(config.anthropicApiKey, config.claudeModel));
  }

  if (providers.length === 0) {
    throw new Error(
      "No LLM providers enabled. Set at least one of OPENAI_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY."
    );
  }

  return providers;
}

export function listEnabledProviderNames(): string[] {
  return getEnabledProviders().map((p) => `${p.name}:${p.model}`);
}

export function getProvider(name: ProviderName): LlmProvider {
  const provider = getEnabledProviders().find((p) => p.name === name);
  if (!provider) {
    throw new Error(`Provider "${name}" is not enabled (missing API key)`);
  }
  return provider;
}

export function getGeminiProvider(): LlmProvider {
  return getProvider("gemini");
}

/** Prefer Gemini for prompt/context work; fall back to OpenAI/Claude if missing. */
export function getPromptLlm(): LlmProvider {
  const providers = getEnabledProviders();
  const gemini = providers.find((p) => p.name === "gemini");
  if (gemini) return gemini;
  const openai = providers.find((p) => p.name === "openai");
  if (openai) {
    log.warn("GEMINI_API_KEY missing — using OpenAI for prompt/context generation");
    return openai;
  }
  return providers[0];
}

/**
 * Prefer Gemini, but on failure (quota/rate-limit) fall back to another enabled provider.
 */
export async function completePreferringGemini(
  system: string,
  user: string
): Promise<{ text: string; provider: ProviderName; model: string }> {
  const providers = getEnabledProviders();
  const ordered = [
    ...providers.filter((p) => p.name === "gemini"),
    ...providers.filter((p) => p.name !== "gemini"),
  ];

  let lastError: unknown;
  for (const provider of ordered) {
    try {
      log.info("LLM complete attempt", {
        provider: provider.name,
        model: provider.model,
      });
      const text = await provider.complete(system, user);
      return { text, provider: provider.name, model: provider.model };
    } catch (error) {
      lastError = error;
      log.warn("LLM complete failed — trying next provider", {
        provider: provider.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("All LLM providers failed for complete()");
}

export function requireGemini(): LlmProvider {
  return getPromptLlm();
}
