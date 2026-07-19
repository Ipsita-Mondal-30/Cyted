import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { completePreferringGemini } from "@/lib/providers/provider-manager";

const log = createLogger("service:prompt");

export type CompanyContext = {
  industry: string;
  products: string[];
  services: string[];
  audience: string[];
  useCases: string[];
  keywords: string[];
};

function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("No JSON object found in LLM response");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}

export async function buildCompanyContext(input: {
  companyName: string;
  website?: string | null;
  description?: string | null;
  competitors: string[];
}): Promise<CompanyContext> {
  log.info("Building company context", { companyName: input.companyName });
  const { text: raw, provider, model } = await completePreferringGemini(
    "You are helping generate realistic AI search prompts. Return JSON only. No markdown.",
    `Using the information below, build a structured company profile.

Company Name: ${input.companyName}
Website: ${input.website || "N/A"}
Description: ${input.description || "N/A"}
Competitors: ${input.competitors.length ? input.competitors.join(", ") : "N/A"}

Return JSON only with keys:
- industry (string)
- products (string array)
- services (string array)
- audience (string array)
- useCases (string array)
- keywords (string array)`
  );
  log.info("Company context LLM response received", {
    provider,
    model,
    chars: raw.length,
  });

  const parsed = extractJson<Partial<CompanyContext>>(raw);
  const context: CompanyContext = {
    industry: parsed.industry || "Unknown",
    products: parsed.products || [],
    services: parsed.services || [],
    audience: parsed.audience || [],
    useCases: parsed.useCases || [],
    keywords: parsed.keywords || [],
  };
  log.info("Parsed company context", {
    industry: context.industry,
    products: context.products.length,
    keywords: context.keywords.length,
  });
  return context;
}

export async function generateAndStorePrompts(
  analysisId: string,
  companyName: string,
  context: CompanyContext
): Promise<number> {
  const config = getConfig();
  const categories = config.promptCategories;
  const perCategory = config.promptsPerCategory;

  log.info("Generating prompts", {
    analysisId,
    categories,
    perCategory,
    expectedTotal: categories.length * perCategory,
  });
  const { text: raw, provider, model } = await completePreferringGemini(
    "You generate realistic consumer/buyer prompts that people type into AI assistants. Return JSON only.",
    `Generate exactly ${perCategory} realistic prompts for EACH category below.
The prompts should be natural questions someone might ask an AI when researching products/services related to this company and industry.
Do NOT mention "${companyName}" in every prompt — mix branded and unbranded queries.
Include some comparison and alternative-seeking prompts.

Company: ${companyName}
Industry: ${context.industry}
Products: ${context.products.join(", ")}
Services: ${context.services.join(", ")}
Audience: ${context.audience.join(", ")}
Keywords: ${context.keywords.join(", ")}

Categories:
${categories.map((c) => `- ${c}`).join("\n")}

Return JSON object where each key is a category name and each value is an array of exactly ${perCategory} prompt strings.
Example shape: { "${categories[0]}": ["...", "..."], ... }`
  );
  log.info("Prompt generation LLM response received", {
    analysisId,
    provider,
    model,
    chars: raw.length,
  });

  const parsed = extractJson<Record<string, string[]>>(raw);
  const rows: { analysisId: string; category: string; prompt: string }[] = [];

  for (const category of categories) {
    const list = parsed[category] || [];
    for (const prompt of list.slice(0, perCategory)) {
      if (typeof prompt === "string" && prompt.trim()) {
        rows.push({ analysisId, category, prompt: prompt.trim() });
      }
    }
    while (rows.filter((r) => r.category === category).length < perCategory) {
      rows.push({
        analysisId,
        category,
        prompt: `${category} question about ${context.industry || companyName} options`,
      });
    }
  }

  await prisma.prompt.createMany({ data: rows });
  log.info("Stored prompts", {
    analysisId,
    count: rows.length,
    byCategory: categories.map((c) => ({
      category: c,
      count: rows.filter((r) => r.category === c).length,
    })),
  });
  return rows.length;
}
