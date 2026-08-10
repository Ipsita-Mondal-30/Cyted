import OpenAI from "openai";
import type { LlmProvider, ProviderSearchResult } from "./types";

/** Keep Groq request bodies under their size limit (413 otherwise). */
const MAX_COMPLETE_CHARS = 24_000;
const MAX_SEARCH_PROMPT_CHARS = 4_000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated for length]`;
}

/**
 * Groq OpenAI-compatible API.
 * - search: groq/compound (built-in web search) — short prompts only
 * - complete: lighter model (llama) so extraction/recs don't 413
 */
export function createGroqProvider(
  apiKey: string,
  searchModel: string,
  completeModel?: string
): LlmProvider {
  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });

  const modelForComplete =
    completeModel ||
    (searchModel.includes("compound")
      ? "llama-3.3-70b-versatile"
      : searchModel);

  async function chat(
    model: string,
    system: string,
    user: string
  ): Promise<string> {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: truncate(system, 4_000) },
        { role: "user", content: truncate(user, MAX_COMPLETE_CHARS) },
      ],
      temperature: 0.3,
    });

    return response.choices[0]?.message?.content?.trim() || "";
  }

  return {
    name: "groq",
    // Surface the search model in UI; complete may use a different one
    model: searchModel,

    async search(prompt: string): Promise<ProviderSearchResult> {
      const started = Date.now();

      const system = searchModel.includes("compound")
        ? `You are a helpful AI assistant with live web search.

Search the web. Prefer Reddit, Quora, reviews, forums, news, and official sources.
Mention brands, competitors, pricing and products. Include citations/URLs when available.
Keep the answer under 800 words.`
        : `You are a helpful AI assistant.

Mention brands, competitors, pricing and products when relevant. Include citations if known.
Keep the answer under 800 words.`;

      try {
        const rawResponse = await chat(
          searchModel,
          system,
          truncate(prompt, MAX_SEARCH_PROMPT_CHARS)
        );

        return {
          provider: "groq",
          model: searchModel,
          rawResponse,
          latencyMs: Date.now() - started,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // compound sometimes 413s — fall back to the complete model once
        if (/413|too large|entity too large/i.test(message) && searchModel !== modelForComplete) {
          const rawResponse = await chat(
            modelForComplete,
            `You are a helpful AI assistant. Answer based on general knowledge. Mention brands and competitors when relevant. Keep under 800 words.`,
            truncate(prompt, MAX_SEARCH_PROMPT_CHARS)
          );
          return {
            provider: "groq",
            model: modelForComplete,
            rawResponse,
            latencyMs: Date.now() - started,
          };
        }
        throw error;
      }
    },

    async complete(system: string, user: string): Promise<string> {
      return chat(modelForComplete, system, user);
    },
  };
}
