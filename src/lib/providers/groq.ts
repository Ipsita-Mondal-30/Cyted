import OpenAI from "openai";
import type { LlmProvider, ProviderSearchResult } from "./types";

/**
 * Groq OpenAI-compatible API.
 * Prefer groq/compound (built-in web search) for visibility searches.
 */
export function createGroqProvider(
  apiKey: string,
  model: string
): LlmProvider {
  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });

  async function complete(system: string, user: string): Promise<string> {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content?.trim() || "";
  }

  return {
    name: "groq",
    model,

    async search(prompt: string): Promise<ProviderSearchResult> {
      const started = Date.now();

      // Compound models have built-in web search / tools.
      const system = model.includes("compound")
        ? `You are a helpful AI assistant with live web search and research tools.

Always search the web when answering. Prefer Reddit, Quora, reviews, forums, news, and official sources.
Mention brands, competitors, pricing and products. Include citations/URLs when available.`
        : `You are a helpful AI assistant.

Provide factual information. Mention brands, competitors, pricing and products when relevant.
If you know citations or URLs, include them.`;

      const rawResponse = await complete(system, prompt);

      return {
        provider: "groq",
        model,
        rawResponse,
        latencyMs: Date.now() - started,
      };
    },

    complete,
  };
}
