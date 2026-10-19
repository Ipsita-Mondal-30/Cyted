# Strand — AI Visibility (AEO) Analytics

Strand measures how often, and how positively, AI assistants recommend your brand. You enter your company and competitors; Strand asks ChatGPT, Gemini, Claude and Groq realistic buyer questions with live web search, extracts who got mentioned and how, and turns that into a visibility score, charts, and a strategy report you can share.

**Live website:** https://cyted-neon.vercel.app/

## How it works

```
Browser ──► Next.js (UI + API routes) ──► Postgres (Supabase)
                                              ▲
                                              │ picks up QUEUED jobs
                                       Analysis worker ──► OpenAI · Gemini · Claude · Groq
```

1. **Start an analysis.** A logged-in user submits a company name, website, description and optional competitors. `POST /api/analysis/create` saves an `AnalysisJob` with status `QUEUED`. The web app never calls an LLM itself.
2. **The worker picks it up.** `src/workers/analysis.worker.ts` is a separate long-running process. In the default **direct** mode it polls Postgres for queued jobs; in **queue** mode it consumes a BullMQ queue on Redis. Admins switch modes at `/admin`.
3. **Pipeline per job** (progress is written back to the job so the dashboard can poll it):
   1. *Competitors* — names are typo-corrected, extra competitors are discovered, and each brand is resolved to a domain (`competitor.service.ts`).
   2. *Prompts* — buyer-intent questions are generated per category, e.g. discovery, comparison, best-of (`prompt.service.ts`).
   3. *Search* — every prompt is sent to every enabled provider concurrently, with per-provider limits and retries (`search.service.ts`, `lib/providers/*`).
   4. *Extraction* — each raw answer is turned into structured data: brands mentioned, your ranking position, sentiment, citations (`extraction.service.ts`).
   5. *Metrics* — mention rate, share of voice, citation rate, recommendation rate, average rank and the overall visibility score (`metrics.service.ts`).
   6. *Recommendations* — an LLM writes a strategy report and content suggestions (`recommendation.service.ts`).
4. **View the report.** `/dashboard/[jobId]` polls `/api/analysis/status/[jobId]` until the job completes, then loads `/api/analysis/results/[jobId]`. Completed reports can be shared publicly at `/report/[jobId]` with no login.

### Visibility score

A weighted blend of five signals, scored 0–100 (weights live in `src/lib/report-analytics.ts` and are shared by the worker and the charts):

| Signal | Weight | Meaning |
|---|---|---|
| Mention rate | 35% | Share of prompts where any engine mentions you |
| Share of voice | 25% | Your mentions ÷ all tracked-brand mentions |
| Recommendation rate | 25% | Answers that mention you positively or rank you top 3 |
| Citation rate | 10% | Your mentions that come with a cited source |
| Ranking position | 5% | `1 − (avg rank − 1) / 10`, floored at 0 |

### Report charts

The report page (`AnalysisDashboard.tsx` + `ReportCharts.tsx`, plain SVG/CSS, no chart library) shows:

- Ring gauges on each insight card, and a visibility-score breakdown showing points earned per signal
- Share-of-voice donut across your brand and competitors
- Performance by answer engine — mention rate and positive sentiment per provider, with average rank
- Sentiment split, ranking-position histogram, and visibility by prompt type
- A brand × engine heatmap of mention rates

Per-engine and per-category numbers are computed in the browser from the stored responses (`computeReportAnalytics`). The History page (`/dashboard`) adds a visibility-over-time line chart and a score bar per analysis.

### Brand logos

Logos are served by the app's own route, `GET /api/logo?domain=…&size=…&name=…`. It fetches the favicon server-side (Google, then DuckDuckGo), caches it, and returns an initials badge if nothing is found, so an image always loads. API routes bypass the auth middleware, so logos work for logged-in and logged-out users alike.

### Auth

Google sign-in via Supabase. `src/middleware.ts` refreshes the session cookie and redirects protected pages (`/dashboard`, etc.) to `/login`; `/`, `/login`, `/report/*`, `/admin` and all `/api/*` routes skip it.

## Tech stack

Next.js 16 (App Router) · React 19 · Tailwind CSS 4 · Prisma 6 + Postgres (Supabase) · Supabase Auth · BullMQ + Redis (optional) · OpenAI, Gemini, Anthropic and Groq SDKs.

## Running locally

### Prerequisites

- Node.js 20+
- A [Supabase](https://supabase.com) project with Google OAuth enabled
- At least one LLM key: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` or `GROQ_API_KEY`
- Redis only if you use queue mode — [Upstash](https://upstash.com) or `docker compose up -d`

### Setup

```bash
npm install
cp .env.example .env      # then fill it in (table below)
npm run db:push           # apply the Prisma schema
npm run db:generate       # generate the Prisma client
```

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | Supabase → Database → connection string, **Transaction pooler** (port 6543). URL-encode special characters in the password (`@` → `%40`). |
| `DIRECT_URL` | Same credentials, **Session pooler** (port 5432), no `pgbouncer` param. Needed by `prisma db push`. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API |
| `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY` | Provider consoles. A provider is enabled when its key is set (and it's switched on in `/admin`). |
| `REDIS_URL` | Queue mode only. Upstash → Connect → ioredis URL; must be `rediss://` (TLS). `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` work as a fallback. |
| `NEXT_PUBLIC_APP_URL` | Public URL of the app, used for OAuth redirects and share links. |

Model names, prompt counts and concurrency limits are also in `.env.example`; see `docs/configuration.md`.

In Supabase, enable the Google provider and add `http://localhost:3000/auth/callback` as a redirect URL.

### Run (two terminals — both are required)

```bash
npm run dev       # Next.js UI + API on http://localhost:3000
npm run worker    # processes analyses
```

Without the worker, jobs stay `QUEUED` while the dashboard keeps polling.

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` / `npm start` | Production build / serve |
| `npm run worker` | Analysis worker |
| `npm run dev:worker` | Worker with `.env` loaded and file watching |
| `npm run lint` | ESLint |
| `npm run db:push` | Apply the Prisma schema to Postgres |
| `npm run db:generate` | Generate the Prisma client |

## Project layout

```
src/
  app/            pages (/, /dashboard, /report, /admin, /login) and API routes
  components/     UI: AnalysisDashboard, ReportCharts, BrandLogo, …
  lib/
    providers/    one adapter per LLM provider
    services/     pipeline steps (competitor, prompt, search, extraction, metrics, recommendation)
    report-analytics.ts   shared scoring weights + per-engine/category analytics
  workers/        analysis worker
prisma/           database schema
docs/             architecture, data model, API routes, deep dives
```

More detail: `docs/architecture-overview.md`, `docs/dataflow.md`, `docs/api-routes.md` and `docs/deep-dive/`.
