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
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: user }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    return textBlock && textBlock.type === "text" ? textBlock.text : "";
  }

  return {
    name: "claude",
    model,
    async search(prompt: string): Promise<ProviderSearchResult> {
      const started = Date.now();
      const rawResponse = await complete(
        "You are a helpful AI assistant. Answer the user's question thoroughly. Mention specific brands and products when recommending. Include any web sources or citations if you would normally reference them.",
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
