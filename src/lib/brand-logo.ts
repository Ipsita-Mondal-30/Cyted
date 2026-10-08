/**
 * Resolve brand logo URLs from a website or brand name.
 * Logos are served through the same-origin /api/logo proxy, which fetches
 * favicons server-side and falls back to an initials badge.
 */

const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function hostnameFromUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const host = new URL(withProto).hostname.replace(/^www\./, "");
    return host || null;
  } catch {
    return null;
  }
}

export function normalizeDomain(input?: string | null): string | null {
  const host = hostnameFromUrl(input?.trim())?.toLowerCase();
  return host && DOMAIN_RE.test(host) ? host : null;
}

export function guessDomainFromName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  return cleaned ? `${cleaned}.com` : "example.com";
}

export function logoUrlFromDomain(
  domain: string,
  size = 128,
  name?: string
): string {
  const params = new URLSearchParams({
    domain: normalizeDomain(domain) || domain,
    size: String(size),
  });
  if (name) params.set("name", name);
  return `/api/logo?${params.toString()}`;
}

/**
 * Extract the brand domain from a stored logo URL. Older reports stored
 * Clearbit URLs (logo.clearbit.com/<domain>), newer ones the /api/logo proxy.
 */
export function domainFromLogoUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, "http://localhost");
    if (parsed.pathname === "/api/logo") {
      return normalizeDomain(parsed.searchParams.get("domain"));
    }
    if (parsed.hostname === "logo.clearbit.com") {
      return normalizeDomain(decodeURIComponent(parsed.pathname.slice(1)));
    }
  } catch {
    // not a URL we recognize
  }
  return null;
}

export function resolveBrandDomain(input: {
  name: string;
  website?: string | null;
  domain?: string | null;
}): string {
  return (
    normalizeDomain(input.domain) ||
    normalizeDomain(input.website) ||
    guessDomainFromName(input.name)
  );
}

export function buildLogoMap(input: {
  companyName: string;
  website?: string | null;
  companyDomain?: string | null;
  competitors: Array<{ name: string; domain?: string | null }>;
}): Record<string, string> {
  const map: Record<string, string> = {};
  const companyDomain = resolveBrandDomain({
    name: input.companyName,
    website: input.website,
    domain: input.companyDomain,
  });
  map[input.companyName] = logoUrlFromDomain(companyDomain, 128, input.companyName);
  for (const c of input.competitors) {
    if (!c.name) continue;
    map[c.name] = logoUrlFromDomain(
      resolveBrandDomain({ name: c.name, domain: c.domain }),
      128,
      c.name
    );
  }
  return map;
}
