import { GoogleGenAI } from "@google/genai";
import type { LlmProvider, ProviderSearchResult } from "./types";

export function createGeminiProvider(
  apiKey: string,
  model: string
): LlmProvider {
  const client = new GoogleGenAI({ apiKey });

  async function generate(system: string, user: string): Promise<string> {
    const response = await client.models.generateContent({
      model,
      contents: `${system}\n\n${user}`,
    });

    return response.text ?? "";
  }

  return {
    name: "gemini",
    model,

    async search(prompt: string): Promise<ProviderSearchResult> {
      const started = Date.now();

      const rawResponse = await generate(
        "You are a helpful AI assistant. Answer the user's question thoroughly. Mention specific brands and products when recommending. Include any web sources or citations if you would normally reference them.",
        prompt
      );

      return {
        provider: "gemini",
        model,
        rawResponse,
        latencyMs: Date.now() - started,
      };
    },

    complete: generate,
  };
}
