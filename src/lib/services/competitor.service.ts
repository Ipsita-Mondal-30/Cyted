import { getConfig } from "@/lib/config";
import { createLogger } from "@/lib/logger";
import { completePreferringGemini } from "@/lib/providers/provider-manager";
import { buildLogoMap, hostnameFromUrl } from "@/lib/brand-logo";

const log = createLogger("service:competitors");

export type BrandResolution = {
  companyName: string;
  companyDomain: string | null;
  competitors: string[];
  competitorDomains: Record<string, string>;
  brandLogos: Record<string, string>;
  brandDomains: Record<string, string>;
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

function cleanDomain(domain?: string | null): string | null {
  if (!domain) return null;
  return (
    hostnameFromUrl(domain) ||
    domain
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .trim() ||
    null
  );
}

/**
 * Correct typos, discover up to 5 competitors, hard-cap total list size.
 */
export async function resolveBrandsAndCompetitors(input: {
  companyName: string;
  website?: string | null;
  description?: string | null;
  competitors: string[];
}): Promise<BrandResolution> {
  const maxCompetitors = getConfig().maxCompetitors;
  const seed = input.competitors.slice(0, maxCompetitors);

  log.info("Resolving brands + discovering competitors", {
    companyName: input.companyName,
    seedCompetitors: seed,
    maxCompetitors,
  });

  const { text } = await completePreferringGemini(
    "You fix brand name typos and discover real competitors. Return JSON only.",
    `Company (may contain typos): ${input.companyName}
Website: ${input.website || "N/A"}
Description: ${input.description || "N/A"}
User-provided competitors (may contain typos): ${
      seed.length ? seed.join(", ") : "none"
    }

Tasks:
1. Correct the company name spelling/casing to the well-known brand (keep meaning).
2. Provide the company's primary website domain (e.g. "nike.com") if known.
3. Correct each user-provided competitor name and give each a primary domain.
4. Discover up to 5 additional REAL competitors in the same market that are NOT the company and NOT already in the user list (after correction), each with a domain.
5. Prefer the most important well-known brands people compare in AI answers.
6. Final competitor list must stay short (max ${maxCompetitors} total).

Return JSON only:
{
  "companyName": "Corrected Company",
  "companyDomain": "example.com",
  "userCompetitors": [{"name":"Corrected","domain":"correct.com"}],
  "discoveredCompetitors": [{"name":"Comp1","domain":"comp1.com"}],
  "corrections": [{"from":"typo","to":"Correct"}]
}`
  );

  const parsed = extractJson<{
    companyName?: string;
    companyDomain?: string;
    userCompetitors?: Array<string | { name?: string; domain?: string }>;
    discoveredCompetitors?: Array<
      string | { name?: string; domain?: string }
    >;
    corrections?: Array<{ from: string; to: string }>;
  }>(text);

  const companyName = (parsed.companyName || input.companyName).trim();
  const companyKey = normalizeKey(companyName);
  const companyDomain =
    cleanDomain(parsed.companyDomain) || hostnameFromUrl(input.website);

  const normalizeList = (
    list: Array<string | { name?: string; domain?: string }> | undefined,
    fallback: string[]
  ) => {
    if (!list?.length) {
      return fallback.map((name) => ({ name, domain: null as string | null }));
    }
    return list
      .map((item) => {
        if (typeof item === "string") {
          return { name: item.trim(), domain: null as string | null };
        }
        return {
          name: (item.name || "").trim(),
          domain: cleanDomain(item.domain),
        };
      })
      .filter((x) => x.name);
  };

  const userCompetitors = normalizeList(parsed.userCompetitors, seed);
  const discovered = normalizeList(parsed.discoveredCompetitors, []).slice(
    0,
    5
  );

  const seen = new Set<string>([companyKey]);
  const competitors: string[] = [];
  const competitorDomains: Record<string, string> = {};

  for (const item of [...userCompetitors, ...discovered]) {
    if (competitors.length >= maxCompetitors) break;
    const key = normalizeKey(item.name);
    if (!key || seen.has(key)) continue;
    if (
      companyKey.includes(key) ||
      key.includes(companyKey) ||
      key === companyKey
    ) {
      continue;
    }
    seen.add(key);
    competitors.push(item.name);
    if (item.domain) competitorDomains[item.name] = item.domain;
  }

  const brandDomains: Record<string, string> = {
    ...competitorDomains,
  };
  if (companyDomain) brandDomains[companyName] = companyDomain;

  const brandLogos = buildLogoMap({
    companyName,
    website: input.website,
    companyDomain,
    competitors: competitors.map((name) => ({
      name,
      domain: competitorDomains[name],
    })),
  });

  const result: BrandResolution = {
    companyName,
    companyDomain,
    competitors,
    competitorDomains,
    brandLogos,
    brandDomains,
    discoveredCompetitors: discovered
      .map((d) => d.name)
      .filter((d) =>
        competitors.some((c) => normalizeKey(c) === normalizeKey(d))
      ),
    corrections: parsed.corrections || [],
  };

  log.info("Brand resolution complete", {
    companyName: result.companyName,
    companyDomain: result.companyDomain,
    competitors: result.competitors,
    corrections: result.corrections,
  });
  return result;
}
