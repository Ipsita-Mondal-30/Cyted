/**
 * Resolve brand logo URLs from a website or brand name.
 * Uses Clearbit with Google Favicon fallback (client onError).
 */

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

export function guessDomainFromName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
  return cleaned ? `${cleaned}.com` : "example.com";
}

export function logoUrlFromDomain(domain: string, size = 128): string {
  const host = domain.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/^www\./, "");
  // Clearbit often has higher-quality marks; Google favicon is the fallback in BrandLogo.
  return `https://logo.clearbit.com/${encodeURIComponent(host)}?size=${size}`;
}

export function faviconUrlFromDomain(domain: string, size = 128): string {
  const host = domain.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").replace(/^www\./, "");
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${size}`;
}

export function resolveBrandDomain(input: {
  name: string;
  website?: string | null;
  domain?: string | null;
}): string {
  return (
    input.domain ||
    hostnameFromUrl(input.website) ||
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
  map[input.companyName] = logoUrlFromDomain(companyDomain);
  for (const c of input.competitors) {
    if (!c.name) continue;
    map[c.name] = logoUrlFromDomain(
      resolveBrandDomain({ name: c.name, domain: c.domain })
    );
  }
  return map;
}
