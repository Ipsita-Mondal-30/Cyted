import OpenAI from "openai";
import type { LlmProvider, ProviderSearchResult } from "./types";

export function createOpenAIProvider(
  apiKey: string,
  model: string
): LlmProvider {
  const client = new OpenAI({ apiKey });

  async function chat(system: string, user: string): Promise<string> {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
    });
    return response.choices[0]?.message?.content ?? "";
  }

  return {
    name: "openai",
    model,
    async search(prompt: string): Promise<ProviderSearchResult> {
      const started = Date.now();
      const rawResponse = await chat(
        "You are a helpful AI assistant. Answer the user's question thoroughly. Mention specific brands and products when recommending. Include any web sources or citations if you would normally reference them.",
        prompt
      );
      return {
        provider: "openai",
        model,
        rawResponse,
        latencyMs: Date.now() - started,
      };
    },
    complete: chat,
  };
}
