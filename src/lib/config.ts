import { z } from "zod";

function splitCsv(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o"),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  CLAUDE_MODEL: z.string().default("claude-sonnet-4-20250514"),
  PROMPTS_PER_CATEGORY: z.coerce.number().int().positive().default(2),
  PROMPT_CATEGORIES: z.string().default("Comparison,Buying,Pricing,Reviews,Features,Alternatives"),
  CONCURRENT_REQUESTS: z.coerce.number().int().positive().default(3),
  MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
});

export type AppConfig = {
  databaseUrl: string;
  redisUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  appUrl: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  anthropicApiKey?: string;
  openaiModel: string;
  geminiModel: string;
  claudeModel: string;
  promptsPerCategory: number;
  promptCategories: string[];
  concurrentRequests: number;
  maxRetries: number;
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
  cached = {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseAnonKey: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    appUrl: env.NEXT_PUBLIC_APP_URL,
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    geminiApiKey: env.GEMINI_API_KEY || undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    openaiModel: env.OPENAI_MODEL,
    geminiModel: env.GEMINI_MODEL,
    claudeModel: env.CLAUDE_MODEL,
    promptsPerCategory: env.PROMPTS_PER_CATEGORY,
    promptCategories: splitCsv(env.PROMPT_CATEGORIES),
    concurrentRequests: env.CONCURRENT_REQUESTS,
    maxRetries: env.MAX_RETRIES,
  };

  if (cached.promptCategories.length === 0) {
    throw new Error("PROMPT_CATEGORIES must include at least one category");
  }

  return cached;
}
