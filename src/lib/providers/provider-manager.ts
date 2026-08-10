import { getConfig } from "@/lib/config";
import { createLogger } from "@/lib/logger";
import { createClaudeProvider } from "./claude";
import { createGeminiProvider } from "./gemini";
import { createGroqProvider } from "./groq";
import { createOpenAIProvider } from "./openai";
import type { LlmProvider, ProviderName } from "./types";
import {
  getProviderFlags,
  isProviderEnabledInFlags,
} from "@/lib/services/provider-settings.service";

const log = createLogger("providers");

/**
 * Build the enabled provider list from current config + admin toggles.
 * Do not cache across jobs — keys/toggles may change without restart.
 */
export async function getEnabledProviders(): Promise<LlmProvider[]> {
  const config = getConfig();
  const flags = await getProviderFlags();
  const providers: LlmProvider[] = [];

  if (config.openaiApiKey && isProviderEnabledInFlags(flags, "openai")) {
    providers.push(createOpenAIProvider(config.openaiApiKey, config.openaiModel));
  }
  if (config.geminiApiKey && isProviderEnabledInFlags(flags, "gemini")) {
    providers.push(createGeminiProvider(config.geminiApiKey, config.geminiModel));
  }
  if (config.anthropicApiKey && isProviderEnabledInFlags(flags, "claude")) {
    providers.push(createClaudeProvider(config.anthropicApiKey, config.claudeModel));
  }
  if (config.groqApiKey && isProviderEnabledInFlags(flags, "groq")) {
    providers.push(
      createGroqProvider(
        config.groqApiKey,
        config.groqModel,
        config.groqCompleteModel
      )
    );
  }

  if (providers.length === 0) {
    throw new Error(
      "No LLM providers enabled. Set an API key and enable the provider in /admin."
    );
  }

  return providers;
}

/** Sync-ish listing for logs — uses env keys only if flags load fails. */
export async function listEnabledProviderNames(): Promise<string[]> {
  const providers = await getEnabledProviders();
  return providers.map((p) => `${p.name}:${p.model}`);
}

export async function getProvider(name: ProviderName): Promise<LlmProvider> {
  const provider = (await getEnabledProviders()).find((p) => p.name === name);
  if (!provider) {
    throw new Error(`Provider "${name}" is not enabled`);
  }
  return provider;
}

export async function getGeminiProvider(): Promise<LlmProvider> {
  return getProvider("gemini");
}

/** Prefer Gemini for prompt/context work; fall back to Groq/OpenAI/Claude. */
export async function getPromptLlm(): Promise<LlmProvider> {
  const providers = await getEnabledProviders();
  const order: ProviderName[] = ["gemini", "groq", "openai", "claude"];
  for (const name of order) {
    const match = providers.find((p) => p.name === name);
    if (match) {
      if (name !== "gemini") {
        log.warn(`Using ${name} for prompt/context generation`);
      }
      return match;
    }
  }
  return providers[0];
}

/**
 * Prefer Gemini, then Groq, then others — fall back on quota/rate-limit failures.
 */
export async function completePreferringGemini(
  system: string,
  user: string
): Promise<{ text: string; provider: ProviderName; model: string }> {
  const providers = await getEnabledProviders();
  const preference: ProviderName[] = ["gemini", "groq", "openai", "claude"];
  const ordered = [
    ...preference
      .map((name) => providers.find((p) => p.name === name))
      .filter((p): p is LlmProvider => Boolean(p)),
    ...providers.filter((p) => !preference.includes(p.name)),
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

export async function requireGemini(): Promise<LlmProvider> {
  return getPromptLlm();
}
