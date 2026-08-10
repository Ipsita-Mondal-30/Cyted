/**
 * Approximate public list prices (USD per 1M tokens).
 * Estimates only — used for admin cost rollups from stored prompt/response text.
 * Update when providers change pricing.
 */
export type ModelRates = {
  inputPer1M: number;
  outputPer1M: number;
};

/** Exact model id → rates */
const EXACT_RATES: Record<string, ModelRates> = {
  // OpenAI
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "gpt-4.1": { inputPer1M: 2, outputPer1M: 8 },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "gpt-5": { inputPer1M: 1.25, outputPer1M: 10 },
  "gpt-5-mini": { inputPer1M: 0.25, outputPer1M: 2 },
  "gpt-5-nano": { inputPer1M: 0.05, outputPer1M: 0.4 },
  // Anthropic
  "claude-sonnet-4-20250514": { inputPer1M: 3, outputPer1M: 15 },
  "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15 },
  "claude-sonnet-4": { inputPer1M: 3, outputPer1M: 15 },
  "claude-opus-4": { inputPer1M: 15, outputPer1M: 75 },
  "claude-3-5-sonnet-latest": { inputPer1M: 3, outputPer1M: 15 },
  "claude-3-5-haiku-latest": { inputPer1M: 0.8, outputPer1M: 4 },
  // Google
  "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
  "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5 },
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10 },
  "gemini-1.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
  "gemini-1.5-pro": { inputPer1M: 1.25, outputPer1M: 5 },
};

/** Prefix / provider fallbacks when model string is unknown */
const PREFIX_RATES: Array<{ match: RegExp; rates: ModelRates }> = [
  { match: /^gpt-5-mini/i, rates: { inputPer1M: 0.25, outputPer1M: 2 } },
  { match: /^gpt-5/i, rates: { inputPer1M: 1.25, outputPer1M: 10 } },
  { match: /^gpt-4o-mini/i, rates: { inputPer1M: 0.15, outputPer1M: 0.6 } },
  { match: /^gpt-4o/i, rates: { inputPer1M: 2.5, outputPer1M: 10 } },
  { match: /^gpt-4\.1-mini/i, rates: { inputPer1M: 0.4, outputPer1M: 1.6 } },
  { match: /^gpt-4/i, rates: { inputPer1M: 2.5, outputPer1M: 10 } },
  { match: /claude.*haiku/i, rates: { inputPer1M: 0.8, outputPer1M: 4 } },
  { match: /claude.*opus/i, rates: { inputPer1M: 15, outputPer1M: 75 } },
  { match: /claude.*sonnet/i, rates: { inputPer1M: 3, outputPer1M: 15 } },
  { match: /claude/i, rates: { inputPer1M: 3, outputPer1M: 15 } },
  { match: /gemini.*2\.5.*pro/i, rates: { inputPer1M: 1.25, outputPer1M: 10 } },
  { match: /gemini.*2\.5.*flash/i, rates: { inputPer1M: 0.3, outputPer1M: 2.5 } },
  { match: /gemini.*flash/i, rates: { inputPer1M: 0.1, outputPer1M: 0.4 } },
  { match: /gemini.*pro/i, rates: { inputPer1M: 1.25, outputPer1M: 5 } },
  { match: /gemini/i, rates: { inputPer1M: 0.3, outputPer1M: 2.5 } },
];

const PROVIDER_DEFAULTS: Record<string, ModelRates> = {
  openai: { inputPer1M: 2.5, outputPer1M: 10 },
  gemini: { inputPer1M: 0.3, outputPer1M: 2.5 },
  claude: { inputPer1M: 3, outputPer1M: 15 },
  anthropic: { inputPer1M: 3, outputPer1M: 15 },
};

const UNKNOWN_RATES: ModelRates = { inputPer1M: 1, outputPer1M: 3 };

export function getModelRates(provider: string, model: string): ModelRates {
  const key = model.trim();
  if (EXACT_RATES[key]) return EXACT_RATES[key];
  for (const row of PREFIX_RATES) {
    if (row.match.test(key)) return row.rates;
  }
  return PROVIDER_DEFAULTS[provider.toLowerCase()] || UNKNOWN_RATES;
}

/** Rough token estimate from character count (OpenAI-style ~4 chars/token). */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateCallCostUsd(input: {
  provider: string;
  model: string;
  promptText?: string | null;
  responseText?: string | null;
}): {
  inputTokens: number;
  outputTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  rates: ModelRates;
} {
  const rates = getModelRates(input.provider, input.model);
  const inputTokens = estimateTokens(input.promptText);
  const outputTokens = estimateTokens(input.responseText);
  const inputCostUsd = (inputTokens / 1_000_000) * rates.inputPer1M;
  const outputCostUsd = (outputTokens / 1_000_000) * rates.outputPer1M;
  return {
    inputTokens,
    outputTokens,
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
    rates,
  };
}

export function formatUsd(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return "$0";
  if (n === 0) return "$0";
  if (n < 0.0001) return `$${n.toExponential(2)}`;
  if (n < 0.01) return `$${n.toFixed(6)}`;
  if (n < 1) return `$${n.toFixed(digits)}`;
  return `$${n.toFixed(2)}`;
}
