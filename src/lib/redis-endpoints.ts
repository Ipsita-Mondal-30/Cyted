import { createLogger } from "@/lib/logger";
import { resolveRedisUrl, redisHostForLogs } from "@/lib/redis-url";

const log = createLogger("redis-endpoints");

/** Primary Upstash (used before env credentials). */
const PRIMARY_UPSTASH = {
  restUrl: "https://clever-shrimp-280777.upstash.io",
  token: "gQAAAAAABEjJAAIgcDExOGE1NjE5YzU1MTg0NzExODM1MGFiNWNhMTNmYjJiYw",
} as const;

let cachedCandidates: string[] | null = null;
let activeIndex = 0;

function primaryRedisUrl(): string {
  return resolveRedisUrl({
    upstashRestUrl: PRIMARY_UPSTASH.restUrl,
    upstashRestToken: PRIMARY_UPSTASH.token,
  });
}

function envRedisUrl(): string | undefined {
  const trim = (v: string | undefined) =>
    v?.trim().replace(/^["']|["']$/g, "") || undefined;

  const redisUrl = trim(process.env.REDIS_URL);
  const upstashRestUrl = trim(process.env.UPSTASH_REDIS_REST_URL);
  const upstashRestToken = trim(process.env.UPSTASH_REDIS_REST_TOKEN);

  if (!redisUrl && !upstashRestUrl && !upstashRestToken) {
    return undefined;
  }

  const resolved = resolveRedisUrl({
    redisUrl,
    upstashRestUrl,
    upstashRestToken,
  });

  if (resolved === "redis://localhost:6379" && !redisUrl) {
    return undefined;
  }

  return resolved;
}

function dedupeByHost(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    const key = redisHostForLogs(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

/** Ordered Redis URLs: hardcoded primary first, then env. */
export function getRedisUrlCandidates(): string[] {
  if (cachedCandidates) return cachedCandidates;

  const list: string[] = [primaryRedisUrl()];
  const fromEnv = envRedisUrl();
  if (fromEnv) list.push(fromEnv);

  cachedCandidates = dedupeByHost(list);
  if (activeIndex >= cachedCandidates.length) {
    activeIndex = Math.max(0, cachedCandidates.length - 1);
  }
  return cachedCandidates;
}

export function getActiveRedisUrl(): string {
  const candidates = getRedisUrlCandidates();
  return candidates[activeIndex] ?? candidates[0] ?? primaryRedisUrl();
}

export function isRedisQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("max requests limit exceeded") ||
    msg.includes("max_requests_limit")
  );
}

/** Move to the next Redis endpoint; returns false if none left. */
export function tryAdvanceRedisEndpoint(): boolean {
  const candidates = getRedisUrlCandidates();
  if (activeIndex >= candidates.length - 1) return false;
  activeIndex += 1;
  return true;
}

export async function withRedisFailover<T>(
  operation: () => Promise<T>
): Promise<T> {
  const maxAttempts = getRedisUrlCandidates().length;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (isRedisQuotaError(err) && tryAdvanceRedisEndpoint()) {
        log.warn("Upstash request quota exceeded; failing over to next Redis", {
          host: redisHostForLogs(getActiveRedisUrl()),
        });
        continue;
      }
      throw err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? "Redis operation failed"));
}

/** Tests / hot reload */
export function resetRedisEndpointState() {
  cachedCandidates = null;
  activeIndex = 0;
}
