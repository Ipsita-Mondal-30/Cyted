import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, ProviderSearchResult } from "./types";

export function createClaudeProvider(
  apiKey: string,
  model: string
): LlmProvider {
  const client = new Anthropic({ apiKey });

  async function complete(system: string, user: string): Promise<string> {
    const response = await client.messages.create({
      model,
      system,
      max_tokens: 4096,

      messages: [
        {
          role: "user",
          content: user,
        },
      ],

      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 5,
        },
      ],
    });

    return response.content
      .filter((block) => block.type === "text")
      .map((block: any) => block.text)
      .join("\n");
  }

  return {
    name: "claude",
    model,

    async search(prompt: string): Promise<ProviderSearchResult> {
      const started = Date.now();

      const rawResponse = await complete(
        `You are a helpful AI assistant.

Always use web search whenever it would improve the answer.

Provide factual, up-to-date information.

Include citations when available.

Mention brands, products and pricing where appropriate.`,
        prompt
      );

      return {
        provider: "claude",
        model,
        rawResponse,
        latencyMs: Date.now() - started,
      };
    },

    complete,
  };
}