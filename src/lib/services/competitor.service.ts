import { createLogger } from "@/lib/logger";
import { completePreferringGemini } from "@/lib/providers/provider-manager";

const log = createLogger("service:competitors");

export type BrandResolution = {
  companyName: string;
  competitors: string[];
  discoveredCompetitors: string[];
  corrections: Array<{ from: string; to: string }>;
};

function extractJson<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("No JSON object found in brand resolution response");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}

function normalizeKey(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Correct typos in company/competitor names and discover up to 5 additional
 * real competitors. Dedupes against the company and user-supplied names.
 */
export async function resolveBrandsAndCompetitors(input: {
  companyName: string;
  website?: string | null;
  description?: string | null;
  competitors: string[];
}): Promise<BrandResolution> {
  log.info("Resolving brands + discovering competitors", {
    companyName: input.companyName,
    seedCompetitors: input.competitors,
  });

  const { text } = await completePreferringGemini(
    "You fix brand name typos and discover real competitors. Return JSON only.",
    `Company (may contain typos): ${input.companyName}
Website: ${input.website || "N/A"}
Description: ${input.description || "N/A"}
User-provided competitors (may contain typos): ${
      input.competitors.length ? input.competitors.join(", ") : "none"
    }

Tasks:
1. Correct the company name spelling/casing to the well-known brand (keep meaning).
2. Correct each user-provided competitor name.
3. Discover exactly 5 additional REAL competitors in the same market that are NOT the company and NOT already in the user list (after correction).
4. Prefer well-known brands / products people compare in AI answers.

Return JSON only:
{
  "companyName": "Corrected Company",
  "userCompetitors": ["corrected", "list"],
  "discoveredCompetitors": ["Comp1","Comp2","Comp3","Comp4","Comp5"],
  "corrections": [{"from":"typo","to":"Correct"}]
}`
  );

  const parsed = extractJson<{
    companyName?: string;
    userCompetitors?: string[];
    discoveredCompetitors?: string[];
    corrections?: Array<{ from: string; to: string }>;
  }>(text);

  const companyName = (parsed.companyName || input.companyName).trim();
  const companyKey = normalizeKey(companyName);

  const userCompetitors = (parsed.userCompetitors || input.competitors)
    .map((c) => c.trim())
    .filter(Boolean);

  const discovered = (parsed.discoveredCompetitors || [])
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 5);

  const seen = new Set<string>([companyKey]);
  const competitors: string[] = [];

  for (const name of [...userCompetitors, ...discovered]) {
    const key = normalizeKey(name);
    if (!key || seen.has(key)) continue;
    // Also skip near-duplicates of company
    if (
      companyKey.includes(key) ||
      key.includes(companyKey) ||
      key === companyKey
    ) {
      continue;
    }
    seen.add(key);
    competitors.push(name);
  }

  const result: BrandResolution = {
    companyName,
    competitors,
    discoveredCompetitors: discovered.filter((d) =>
      competitors.some((c) => normalizeKey(c) === normalizeKey(d))
    ),
    corrections: parsed.corrections || [],
  };

  log.info("Brand resolution complete", result);
  return result;
}
