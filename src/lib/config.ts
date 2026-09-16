import { z } from "zod";
import { getActiveRedisUrl } from "@/lib/redis-endpoints";

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
  /** Lighter Groq model for extraction/recs (compound can 413 on large prompts). */
  GROQ_COMPLETE_MODEL: z.string().default("llama-3.3-70b-versatile"),
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

export { resolveRedisUrl, redisHostForLogs } from "@/lib/redis-url";

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
  groqCompleteModel: string;
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
  // Active URL respects hardcoded-primary → env failover (see redis-endpoints.ts).
  const redisUrl = getActiveRedisUrl();

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
    groqCompleteModel: env.GROQ_COMPLETE_MODEL,
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
