import OpenAI from "openai";
import type { LlmProvider, ProviderSearchResult } from "./types";

export function createOpenAIProvider(
  apiKey: string,
  model: string
): LlmProvider {
  const client = new OpenAI({ apiKey });

  async function complete(system: string, user: string): Promise<string> {
    const response = await client.responses.create({
      model,

      tools: [
        {
          type: "web_search_preview",
        },
      ],

      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: system,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: user,
            },
          ],
        },
      ],
    });

    return response.output_text;
  }

  return {
    name: "openai",
    model,

    async search(prompt: string): Promise<ProviderSearchResult> {
      const started = Date.now();

      const rawResponse = await complete(
        `You are a helpful AI assistant.

Always use web search when it improves the answer.

Provide factual, up-to-date information.

Mention brands, competitors, pricing and products.

Include citations whenever available.`,
        prompt
      );

      return {
        provider: "openai",
        model,
        rawResponse,
        latencyMs: Date.now() - started,
      };
    },

    complete,
  };
}