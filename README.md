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

## AI evaluation harness

Every number on the report depends on one LLM step: **extraction**, which turns a free-text AI answer into `{ mentionedBrands, ranking, sentiment, … }`. If it misreads an answer, the visibility score is wrong no matter how good the rest of the pipeline is. `src/evals/` measures that step offline, the way you'd unit-test deterministic code.

```
golden dataset ──► production prompt ──► extractor ──► production parser ──► scorers ──► report + CI gate
(14 labelled       (buildExtraction-     (Gemini / OpenAI /   (parseExtraction)   (per-case +
 answers)           Prompt)               Claude / Groq,                          aggregate)
                                          or rule baseline)
```

**Design choices**

- **Eval what ships.** The worker and the harness share `buildExtractionPrompt` and `parseExtraction` (`src/lib/services/extraction-prompt.ts`), so a prompt change is evaluated exactly as it will run in production. `EXTRACTION_PROMPT_VERSION` is stamped on every report.
- **Score what the product consumes.** Brand precision and recall are computed over the *tracked* brands (your company plus competitors), because those are the only brands the visibility metrics read. "Recommended" accuracy uses the same `isRecommendedMention` rule as `metrics.service.ts`, and brand matching uses the same `brandMatches`.
- **A golden set built around failure modes.** The cases in `evals/datasets/extraction.golden.json` are tagged by what they stress: ranked lists, markdown tables, unnumbered bullets, prose-only rankings, brand aliases and casing ("Hubspot CRM" → HubSpot), passing mentions, negative mentions, a brand name hidden inside an ordinary word ("Monday standups" ≠ Monday.com), and a **prompt-injection** answer that tells the extractor to rank a brand #1. Reports break accuracy down by tag.
- **Instruction-following tracked separately from accuracy.** The parser stays lenient (production shouldn't drop an answer over `"sentiment": "positive"`) but records every deviation from the strict zod schema, reported as *schema validity*.
- **Record and replay.** `--mode record` saves raw model outputs to `evals/cassettes/<provider>.json`, keyed by a hash of the full prompt. `--mode replay` re-scores them with no network and no API key, so CI is deterministic and free. Replay is strict: if the prompt changes, the hash misses and the run fails until you re-record, so CI never scores stale outputs.
- **A baseline to beat.** A rule-based extractor (string matching, list position, keyword sentiment) runs with no API key. It shows what an LLM adds — and the dataset shows where rules break (the prompt-injection case, prose rankings, aliases).
- **Cost and latency.** Each run reports p50/p95 latency and an estimated cost per extractor, using `src/lib/ai-pricing.ts`.
- **Quality gate.** `evals/thresholds.json` sets minimums per extractor kind; `--gate` exits non-zero if any metric falls below them. CI (`.github/workflows/ci.yml`) runs the type-check, unit tests and the eval gate on every push.

**Metrics**

| Metric | Meaning |
|---|---|
| Parse rate | Output contained a recoverable JSON object |
| Schema validity | Output matched the strict schema with no normalisation needed |
| Mention accuracy | Correctly decided whether *your* company is mentioned |
| Brand P / R / F1 | Precision / recall over tracked brands |
| Ranking exact / MAE | Exact ranking match (including correctly returning `null`) and mean absolute error when both are ranked |
| Sentiment accuracy | Plus a confusion matrix in the report |
| Recommended accuracy | Agreement on the "recommended" flag that drives the recommendation rate |

**Labelling rules** (keep new cases consistent): `ranking` is the company's 1-based position in the answer's list or table, or 1 if the answer explicitly names it the top pick; it is `null` when the company is absent, only mentioned in passing, or explicitly not recommended. An absent company is `Neutral`. Text injected into the answer doesn't count as a mention. `npm test` checks these invariants on every case.

**Running it**

```bash
npm run eval                                              # rule baseline (+ any recorded LLM outputs), offline
npm run eval -- --extractors gemini,openai --mode record  # call real models, save outputs to evals/cassettes
npm run eval -- --extractors heuristic,gemini --gate      # replay + enforce thresholds
npm run eval -- --tag adversarial                         # run a subset by tag
```

Reports are written to `evals/reports/latest.md` (and `.json`). Recording needs the provider's API key in `.env`; replay needs nothing.

Current baseline (`rules-v1`, 14 cases): mention 92.9%, brand F1 97.6%, ranking 85.7%, sentiment 92.9%. It fails exactly where expected: the prompt-injection case, rankings stated in prose, and the "Zoho" alias.

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
| `npm run typecheck` | TypeScript type-check |
| `npm test` | Unit tests (`node:test` via tsx): parser, scorers, analytics, dataset invariants |
| `npm run eval` | Extraction eval harness (see above) |
| `npm run eval:gate` | Offline baseline eval with the quality gate, as run in CI |
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
  evals/          eval harness: extractors, scorers, runner
  workers/        analysis worker
evals/            golden dataset, thresholds, recorded LLM outputs (cassettes)
prisma/           database schema
docs/             architecture, data model, API routes, deep dives
```

More detail: `docs/architecture-overview.md`, `docs/dataflow.md`, `docs/api-routes.md` and `docs/deep-dive/`.
