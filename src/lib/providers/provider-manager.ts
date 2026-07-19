import { getConfig } from "@/lib/config";
import { createClaudeProvider } from "./claude";
import { createGeminiProvider } from "./gemini";
import { createOpenAIProvider } from "./openai";
import type { LlmProvider, ProviderName } from "./types";

let cachedProviders: LlmProvider[] | null = null;

export function getEnabledProviders(): LlmProvider[] {
  if (cachedProviders) return cachedProviders;

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

  cachedProviders = providers;
  return providers;
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

export function requireGemini(): LlmProvider {
  const config = getConfig();
  if (!config.geminiApiKey) {
    throw new Error("GEMINI_API_KEY is required for prompt generation and company context");
  }
  return getGeminiProvider();
}
