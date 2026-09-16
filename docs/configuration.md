# Configuration

All configuration is centralized in `src/lib/config.ts`. It reads from environment variables, validates with Zod, and returns a typed `AppConfig` object. The result is cached after the first parse — call `resetConfigCache()` in tests to clear it.

---

## Environment Variables Reference

### Required

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string for the **transaction pooler** (Supabase port 6543). Used by the app at runtime. The config module automatically appends `?connection_limit=5&pool_timeout=20`. |
| `DIRECT_URL` | PostgreSQL connection string for the **session pooler** (Supabase port 5432). Used by Prisma for schema migrations only (`prisma migrate deploy`). |
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL (e.g. `https://xyz.supabase.co`). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase public anon key. Safe to expose to the browser. |

### Application URL

| Variable | Default | Description |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | The public URL of the app. Used to construct OAuth redirect URLs and shareable report links. Must be an HTTPS URL in production. |

### AI Provider Keys (all optional — at least one required)

| Variable | Provider |
|---|---|
| `OPENAI_API_KEY` | OpenAI (GPT-4o with web search) |
| `GEMINI_API_KEY` | Google Gemini (strongly recommended — used as primary for all structured tasks) |
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `GROQ_API_KEY` | Groq (compound model + Llama) |

A provider is only active if its key is set **and** its admin toggle is on. If no providers are active, the worker will throw and fail every job.

**Recommendation**: Set at minimum `GEMINI_API_KEY`. Gemini is the preferred provider for context, prompt generation, extraction, and recommendations. Add other keys to increase search coverage.

### AI Model Overrides (all optional)

| Variable | Default | Notes |
|---|---|---|
| `OPENAI_MODEL` | `gpt-4o` | Must support the Responses API and `web_search_preview` tool |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Must support `googleSearch` grounding tool |
| `CLAUDE_MODEL` | `claude-sonnet-4-20250514` | Must support `web_search_20250305` tool |
| `GROQ_MODEL` | `groq/compound` | The Groq model used for search (has built-in web search) |
| `GROQ_COMPLETE_MODEL` | `llama-3.3-70b-versatile` | Lighter Groq model used for extraction/recommendations. Avoids 413 errors on large prompts. |

### Analysis Tuning

| Variable | Default | Description |
|---|---|---|
| `PROMPTS_PER_CATEGORY` | `2` | Number of search prompts generated per category. Total prompts = `PROMPTS_PER_CATEGORY × number of categories`. |
| `PROMPT_CATEGORIES` | `Comparison,Buying,Pricing,Reviews,Features,Alternatives` | Comma-separated list of prompt categories. At least one required. |
| `MAX_COMPETITORS` | `8` | Hard cap on competitor count. User-supplied competitors are sliced to this limit before brand resolution. Discovered competitors are also bounded by this. |

### Concurrency Controls

| Variable | Default | Description |
|---|---|---|
| `CONCURRENT_REQUESTS` | `4` | Global baseline for parallel LLM calls. Used as the default for `SEARCH_CONCURRENCY` and capped for `EXTRACT_CONCURRENCY`. Lower on free-tier Supabase/Render to avoid connection pool exhaustion. |
| `SEARCH_CONCURRENCY` | `CONCURRENT_REQUESTS` | Total number of in-flight provider search calls at once (across all providers). |
| `PER_PROVIDER_CONCURRENCY` | `2` | Max in-flight calls to a single provider simultaneously. Helps stay within per-provider rate limits. |
| `EXTRACT_CONCURRENCY` | `min(CONCURRENT_REQUESTS, 3)` | Parallel extraction calls. Capped at 3 by default to limit `complete()` API pressure during the extraction step. |
| `MAX_RETRIES` | `2` | Retry count for individual LLM calls (3 total attempts: 1 + 2 retries). Also used for DB write retries in `prismaWrite()`. |

### Redis / Queue

| Variable | Description |
|---|---|
| `REDIS_URL` | Standard Redis URL (`redis://` or `rediss://`). Preferred if set. Upstash connections must use `rediss://` (TLS). |
| `UPSTASH_REDIS_REST_URL` | Upstash REST URL (fallback if `REDIS_URL` not set). The config constructs a `rediss://` TLS URL from this + the token. |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST token (required if using `UPSTASH_REDIS_REST_URL`). |

The config resolves Redis in this priority order:
1. `REDIS_URL` if it looks like `redis://` or `rediss://`
2. Constructed TLS URL from `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
3. Falls back to `redis://localhost:6379` if neither is set

**Upstash note**: Plain `redis://` URLs to `*.upstash.io` are automatically upgraded to `rediss://` (TLS) because non-TLS connections cause `ECONNRESET`/`EPIPE` errors with Upstash.

---

## AppConfig Type

After parsing, `getConfig()` returns an `AppConfig` object:

```typescript
type AppConfig = {
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
```

---

## Runtime Feature Flags (Database)

In addition to environment variables, there are **runtime toggles** stored in the `SystemConfig` table. These can be changed without redeploying.

| Flag | Location | Description |
|---|---|---|
| `enabledProviders.openai` | `SystemConfig` DB row | Enable/disable OpenAI at runtime |
| `enabledProviders.gemini` | `SystemConfig` DB row | Enable/disable Gemini at runtime |
| `enabledProviders.claude` | `SystemConfig` DB row | Enable/disable Claude at runtime |
| `enabledProviders.groq` | `SystemConfig` DB row | Enable/disable Groq at runtime |

Managed via the `/admin` page (`AdminProviderToggles` component → `PUT /api/admin/providers`).

Provider flags default to `true` when not explicitly set in the DB — meaning a provider is active as long as its API key is present.

---

## Example `.env` File

See `.env.example` in the repo root. A minimal working setup:

```bash
# Database (Supabase)
DATABASE_URL="postgresql://postgres.xyz:[password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres"
DIRECT_URL="postgresql://postgres.xyz:[password]@aws-0-us-east-1.pooler.supabase.com:5432/postgres"

# Supabase Auth
NEXT_PUBLIC_SUPABASE_URL="https://xyz.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="eyJ..."

# App URL
NEXT_PUBLIC_APP_URL="http://localhost:3000"

# AI Providers (add at least one)
GEMINI_API_KEY="AIza..."
OPENAI_API_KEY="sk-..."
# ANTHROPIC_API_KEY="sk-ant-..."
# GROQ_API_KEY="gsk_..."

# Redis (local dev)
REDIS_URL="redis://localhost:6379"

# Redis (Upstash production — use one of these approaches)
# REDIS_URL="rediss://default:[token]@[host].upstash.io:6379"
# UPSTASH_REDIS_REST_URL="https://[host].upstash.io"
# UPSTASH_REDIS_REST_TOKEN="[token]"
```

---

## Configuration Validation

The Zod schema validates the environment on first call to `getConfig()`. If any required variable is missing or malformed, the process throws immediately with a descriptive error listing every failing field:

```
Error: Invalid environment configuration:
  DATABASE_URL: Required
  NEXT_PUBLIC_SUPABASE_URL: Invalid url
```

Blank/whitespace values are treated as unset (same as missing). Surrounding quotes on values are stripped automatically (handles copy-paste errors from some secret managers).

---

## Docker Compose (Local Development)

`docker-compose.yml` starts a local Redis instance for development:

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

Run with `docker compose up -d` then set `REDIS_URL=redis://localhost:6379`.

You still need a Supabase project for the database and auth — there's no local Postgres container configured. Use Supabase's local CLI or a free Supabase cloud project.
