# Strand — AI Visibility MVP

Analyze how often and how positively your brand is recommended across AI assistants (OpenAI, Gemini, Claude).

## Prerequisites

- Node.js 20+
- Redis via [Upstash](https://upstash.com) (recommended) or local Docker
- A [Supabase](https://supabase.com) project with Google OAuth enabled
- At least one LLM API key (`OPENAI_API_KEY`, `GEMINI_API_KEY`, or `ANTHROPIC_API_KEY`)

## Setup

1. **Install dependencies**

```bash
npm install
# or: yarn install
```

2. **Redis**

With Upstash, skip Docker — set `REDIS_URL` / Upstash vars in `.env` (see below).

For local Redis only:

```bash
docker compose up -d
```

3. **Configure environment**

```bash
cp .env.example .env
```

Fill in:

| Variable | Where to get it |
|----------|-----------------|
| `DATABASE_URL` | Supabase → Database → Connection string (URI), **Transaction pooler** (port 6543). URL-encode special chars in the password (`@` → `%40`). |
| `DIRECT_URL` | Same credentials with **Session pooler** (port 5432), no `pgbouncer` param — required for `prisma db push`. |
| `REDIS_URL` | Upstash → Connect → **ioredis** URL. Must be `rediss://` (TLS). Plain `redis://` causes endless ECONNRESET on Render/Vercel. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Optional. If `REDIS_URL` is missing, the app builds `rediss://default:TOKEN@host:6379` from these. |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Respective provider consoles |

4. **Supabase Google OAuth**

- Authentication → Providers → Google → enable and add Client ID/Secret
- Authentication → URL Configuration → add redirect URL: `http://localhost:3000/auth/callback`

5. **Push database schema**

```bash
npm run db:push
npm run db:generate
``` a

6. **Run the app** (two terminals — both are required)

```bash
npm run dev          # Next.js UI + API
npm run worker       # BullMQ worker that actually runs analyses
```

Without the worker, jobs stay `QUEUED` forever while the dashboard polls.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Next.js app |
| `npm run worker` | BullMQ analysis worker |
| `npm run db:push` | Apply Prisma schema to Postgres |
| `npm run db:generate` | Generate Prisma client |

## Architecture

- **Postgres (Supabase)** — source of truth for users, companies, analyses
- **Redis** — BullMQ queue only
- **Worker** — generates prompts → searches providers → extracts → metrics → recommendations
