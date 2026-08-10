import { GoogleGenAI } from "@google/genai";
import type { LlmProvider, ProviderSearchResult } from "./types";

export function createGeminiProvider(
  apiKey: string,
  model: string
): LlmProvider {
  const client = new GoogleGenAI({ apiKey });

  async function generate(
    system: string,
    user: string,
    withSearch = false
  ): Promise<string> {
    const response = await client.models.generateContent({
      model,
      contents: `${system}\n\n${user}`,
      config: withSearch
        ? {
            tools: [{ googleSearch: {} }],
          }
        : undefined,
    });

    return response.text ?? "";
  }

  return {
    name: "gemini",
    model,

    async search(prompt: string): Promise<ProviderSearchResult> {
      const started = Date.now();

      const rawResponse = await generate(
        `You are a helpful AI assistant with live web search.

Always search the web when answering. Prefer sources like official sites, Reddit, Quora, review sites, news, and forums.

Mention specific brands and products when recommending. Include citations/URLs when available.`,
        prompt,
        true
      );

      return {
        provider: "gemini",
        model,
        rawResponse,
        latencyMs: Date.now() - started,
      };
    },

    complete: (system, user) => generate(system, user, false),
  };
}
