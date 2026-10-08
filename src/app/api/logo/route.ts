import { NextResponse, type NextRequest } from "next/server";
import { normalizeDomain } from "@/lib/brand-logo";

const GOOGLE_SIZES = [16, 32, 64, 128, 256];
const FETCH_TIMEOUT_MS = 4000;
const MEMORY_CACHE_LIMIT = 500;

const HIT_CACHE_CONTROL =
  "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800";
const MISS_CACHE_CONTROL = "public, max-age=3600, s-maxage=86400";

type CachedLogo = { body: ArrayBuffer; contentType: string };

const memoryCache = new Map<string, CachedLogo>();

function remember(key: string, value: CachedLogo) {
  if (memoryCache.size >= MEMORY_CACHE_LIMIT) {
    const oldest = memoryCache.keys().next().value;
    if (oldest !== undefined) memoryCache.delete(oldest);
  }
  memoryCache.set(key, value);
}

function upstreamSources(domain: string, size: number): string[] {
  const sz = GOOGLE_SIZES.find((s) => s >= size) ?? 256;
  return [
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=${sz}`,
    `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
  ];
}

async function fetchLogo(domain: string, size: number): Promise<CachedLogo | null> {
  for (const url of upstreamSources(domain, size)) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; StrandLogoProxy/1.0)" },
      });
      const contentType = res.headers.get("content-type") || "";
      if (!res.ok || !contentType.startsWith("image/")) continue;
      const body = await res.arrayBuffer();
      if (body.byteLength === 0) continue;
      return { body, contentType };
    } catch {
      // try the next source
    }
  }
  return null;
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function initialsSvg(label: string, size: number) {
  const text = escapeXml(
    (label.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2) || "?").toUpperCase()
  );
  let hash = 0;
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 35% 22%)"/><text x="32" y="33" dominant-baseline="middle" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="24" font-weight="600" fill="hsl(${hue} 70% 85%)">${text}</text></svg>`;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const domain = normalizeDomain(params.get("domain"));
  const name = (params.get("name") || domain || "?").slice(0, 40);
  const size = Math.min(256, Math.max(16, Number(params.get("size")) || 64));

  if (domain) {
    const key = `${domain}:${size}`;
    let logo = memoryCache.get(key) ?? null;
    if (!logo) {
      logo = await fetchLogo(domain, size);
      if (logo) remember(key, logo);
    }
    if (logo) {
      return new NextResponse(logo.body, {
        headers: {
          "Content-Type": logo.contentType,
          "Cache-Control": HIT_CACHE_CONTROL,
        },
      });
    }
  }

  return new NextResponse(initialsSvg(name, size), {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": MISS_CACHE_CONTROL,
    },
  });
}
