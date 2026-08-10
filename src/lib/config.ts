import { z } from "zod";

function splitCsv(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Treat blank env values as unset; strip surrounding quotes. */
const optionalKey = z
  .string()
  .optional()
  .transform((v) => {
    const trimmed = v?.trim().replace(/^["']|["']$/g, "");
    return trimmed ? trimmed : undefined;
  });

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: optionalKey,
  UPSTASH_REDIS_REST_URL: optionalKey,
  UPSTASH_REDIS_REST_TOKEN: optionalKey,
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  OPENAI_API_KEY: optionalKey,
  GEMINI_API_KEY: optionalKey,
  ANTHROPIC_API_KEY: optionalKey,
  GROQ_API_KEY: optionalKey,
  OPENAI_MODEL: z.string().default("gpt-4o"),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  CLAUDE_MODEL: z.string().default("claude-sonnet-4-20250514"),
  GROQ_MODEL: z.string().default("groq/compound"),
  PROMPTS_PER_CATEGORY: z.coerce.number().int().positive().default(2),
  PROMPT_CATEGORIES: z.string().default("Comparison,Buying,Pricing,Reviews,Features,Alternatives"),
  /** Global default for parallel LLM calls (search + extract). Keep modest on Render/Supabase. */
  CONCURRENT_REQUESTS: z.coerce.number().int().positive().default(4),
  /** Parallel provider searches (prompt × provider). Defaults to CONCURRENT_REQUESTS. */
  SEARCH_CONCURRENCY: z.coerce.number().int().positive().optional(),
  /** Parallel extraction calls. Defaults to min(CONCURRENT_REQUESTS, 3). */
  EXTRACT_CONCURRENCY: z.coerce.number().int().positive().optional(),
  /** Concurrent in-flight searches per provider (providers still run in parallel). */
  PER_PROVIDER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
  /** Max competitors tracked per analysis (user + discovered). */
  MAX_COMPETITORS: z.coerce.number().int().positive().default(8),
});

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

export type AppConfig = {
  databaseUrl: string;
  redisUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  appUrl: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  anthropicApiKey?: string;
  groqApiKey?: string;
  openaiModel: string;
  geminiModel: string;
  claudeModel: string;
  groqModel: string;
  promptsPerCategory: number;
  promptCategories: string[];
  concurrentRequests: number;
  searchConcurrency: number;
  extractConcurrency: number;
  perProviderConcurrency: number;
  maxRetries: number;
  maxCompetitors: number;
};

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const env = parsed.data;
  const redisUrl = resolveRedisUrl({
    redisUrl: env.REDIS_URL,
    upstashRestUrl: env.UPSTASH_REDIS_REST_URL,
    upstashRestToken: env.UPSTASH_REDIS_REST_TOKEN,
  });

  cached = {
    databaseUrl: env.DATABASE_URL,
    redisUrl,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    appUrl: env.NEXT_PUBLIC_APP_URL,
    openaiApiKey: env.OPENAI_API_KEY,
    geminiApiKey: env.GEMINI_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    groqApiKey: env.GROQ_API_KEY,
    openaiModel: env.OPENAI_MODEL,
    geminiModel: env.GEMINI_MODEL,
    claudeModel: env.CLAUDE_MODEL,
    groqModel: env.GROQ_MODEL,
    promptsPerCategory: env.PROMPTS_PER_CATEGORY,
    promptCategories: splitCsv(env.PROMPT_CATEGORIES),
    concurrentRequests: env.CONCURRENT_REQUESTS,
    searchConcurrency: env.SEARCH_CONCURRENCY ?? env.CONCURRENT_REQUESTS,
    extractConcurrency:
      env.EXTRACT_CONCURRENCY ?? Math.min(env.CONCURRENT_REQUESTS, 3),
    perProviderConcurrency: env.PER_PROVIDER_CONCURRENCY,
    maxRetries: env.MAX_RETRIES,
    maxCompetitors: env.MAX_COMPETITORS,
  };

  if (cached.promptCategories.length === 0) {
    throw new Error("PROMPT_CATEGORIES must include at least one category");
  }

  return cached;
}

/** Clear cached config (e.g. tests). */
export function resetConfigCache() {
  cached = null;
}
