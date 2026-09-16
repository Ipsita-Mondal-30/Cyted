/**
 * BullMQ needs a Redis protocol URL (redis:// or rediss://), not Upstash REST.
 * Prefer REDIS_URL when it looks valid; otherwise build TLS URL from Upstash REST host + token.
 * Upstash always requires TLS — plain redis:// to *.upstash.io is upgraded to rediss://.
 */
export function resolveRedisUrl(input: {
  redisUrl?: string;
  upstashRestUrl?: string;
  upstashRestToken?: string;
}): string {
  const raw = input.redisUrl?.trim().replace(/^["']|["']$/g, "");

  let candidate: string | undefined;

  if (raw && (raw.startsWith("redis://") || raw.startsWith("rediss://"))) {
    candidate = raw;
  } else if (raw) {
    // Accidental paste of `redis-cli --tls -u redis://...` — extract the URL
    const match = raw.match(/(rediss?:\/\/\S+)/);
    if (match?.[1]) candidate = match[1];
  }

  if (!candidate && input.upstashRestUrl && input.upstashRestToken) {
    const host = new URL(input.upstashRestUrl).hostname;
    const token = encodeURIComponent(input.upstashRestToken);
    candidate = `rediss://default:${token}@${host}:6379`;
  }

  if (!candidate) {
    return "redis://localhost:6379";
  }

  // Force TLS for Upstash — non-TLS redis:// causes ECONNRESET / EPIPE loops
  if (
    candidate.startsWith("redis://") &&
    candidate.includes("upstash.io")
  ) {
    candidate = "rediss://" + candidate.slice("redis://".length);
  }

  return candidate;
}

/** Safe host for logs (no password/token). */
export function redisHostForLogs(redisUrl: string): string {
  try {
    return new URL(redisUrl).host;
  } catch {
    return "(invalid-redis-url)";
  }
}
