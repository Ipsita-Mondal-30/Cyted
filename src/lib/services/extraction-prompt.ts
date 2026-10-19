import { z } from "zod";

/**
 * Prompt construction and output parsing for the extraction step, kept free of
 * DB/config imports so the production worker and the eval harness
 * (src/evals) exercise exactly the same prompt and parser.
 */

export const EXTRACTION_PROMPT_VERSION = "extraction-v1";

export const EXTRACTION_SYSTEM_PROMPT =
  "Extract structured brand visibility data from AI assistant answers. Return JSON only.";

const MAX_RESPONSE_CHARS = 12_000;

export type Sentiment = "Positive" | "Neutral" | "Negative";

export type ExtractionPayload = {
  mentionedBrands: string[];
  mentionedProducts: string[];
  citations: string[];
  ranking: number | null;
  reasoning: string;
  sentiment: Sentiment;
};

export type ExtractionInput = {
  companyName: string;
  competitors: string[];
  rawResponse: string;
};

export function buildExtractionPrompt(input: ExtractionInput): {
  system: string;
  user: string;
} {
  const { companyName, competitors, rawResponse } = input;
  return {
    system: EXTRACTION_SYSTEM_PROMPT,
    user: `Company being analyzed: ${companyName}
Competitors: ${competitors.join(", ") || "none"}

AI assistant response:
"""
${rawResponse.slice(0, MAX_RESPONSE_CHARS)}
"""

Return JSON with:
{
  "mentionedBrands": ["brand names mentioned"],
  "mentionedProducts": ["product names mentioned"],
  "citations": ["urls or source names if any"],
  "ranking": <1-based position of ${companyName} if ranked/recommended, or null if not mentioned>,
  "reasoning": "brief explanation of how the company appears",
  "sentiment": "Positive" | "Neutral" | "Negative"
}`,
  };
}

const strictSchema = z.object({
  mentionedBrands: z.array(z.string()),
  mentionedProducts: z.array(z.string()),
  citations: z.array(z.string()),
  ranking: z.number().int().positive().nullable(),
  reasoning: z.string(),
  sentiment: z.enum(["Positive", "Neutral", "Negative"]),
});

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("No JSON object found in extraction response");
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeSentiment(value: unknown): Sentiment {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "positive") return "Positive";
  if (s === "negative") return "Negative";
  return "Neutral";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/**
 * Parse model output leniently (production must not drop a response over a
 * cosmetic deviation) while reporting every deviation from the strict schema,
 * so evals can track instruction-following separately from accuracy.
 * Throws only when no JSON object can be recovered at all.
 */
export function parseExtraction(raw: string): {
  payload: ExtractionPayload;
  schemaIssues: string[];
} {
  const parsed = extractJsonObject(raw) as Record<string, unknown>;
  const strict = strictSchema.safeParse(parsed);
  const schemaIssues = strict.success
    ? []
    : strict.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

  return {
    payload: {
      mentionedBrands: stringArray(parsed.mentionedBrands),
      mentionedProducts: stringArray(parsed.mentionedProducts),
      citations: stringArray(parsed.citations),
      ranking:
        typeof parsed.ranking === "number" && parsed.ranking > 0
          ? Math.round(parsed.ranking)
          : null,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      sentiment: normalizeSentiment(parsed.sentiment),
    },
    schemaIssues,
  };
}
