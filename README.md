# Cyted — AI Visibility MVP

Analyze how often and how positively your brand is recommended across AI assistants (OpenAI, Gemini, Claude).

## Prerequisites

- Node.js 20+
- Docker (for Redis)
- A [Supabase](https://supabase.com) project with Google OAuth enabled
- At least one LLM API key (`GEMINI_API_KEY` required for prompt generation)

## Setup

1. **Install dependencies**

```bash
npm install
# or: yarn install
```

2. **Start Redis**

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
```

6. **Run the app** (two terminals)

```bash
npm run dev
npm run worker
```

Open [http://localhost:3000](http://localhost:3000), sign in with Google, and run an analysis.

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
