export type ProviderName = "openai" | "gemini" | "claude";

export type ProviderSearchResult = {
  provider: ProviderName;
  model: string;
  rawResponse: string;
  latencyMs: number;
};

export interface LlmProvider {
  name: ProviderName;
  model: string;
  search(prompt: string): Promise<ProviderSearchResult>;
  complete(system: string, user: string): Promise<string>;
}
