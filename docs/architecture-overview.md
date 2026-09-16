# Architecture Overview

## What Is This System?

Cyted (branded **Strand**) is an **AI Visibility / Answer Engine Optimization (AEO) analytics platform**. It measures how often a company's brand gets mentioned and recommended by AI assistants — ChatGPT, Gemini, Claude, and Groq. Users enter their company details and competitors, and the platform fires realistic buyer-intent queries across all enabled LLM providers, extracts structured mention data, calculates visibility scores, and delivers a strategic improvement report.

---

## System Components

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser (Client)                     │
│  Next.js App Router Pages + React Client Components         │
│  (Login, Home, Dashboard, Report, Admin)                    │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP (Next.js API Routes)
┌──────────────────────────▼──────────────────────────────────┐
│                    Next.js Server (Node.js)                  │
│  API Routes: /api/analysis/*, /api/company,                 │
│              /api/admin/*, /api/public/*, /auth/*           │
│  Auth: Supabase SSR (cookie-based sessions)                 │
└───────┬──────────────────┬──────────────────────────────────┘
        │ Prisma ORM       │ BullMQ enqueue
        │                  │
┌───────▼──────┐   ┌───────▼──────────────────────────────────┐
│  PostgreSQL  │   │         Redis / Upstash                  │
│  (Supabase)  │   │  Job queue — analysis jobs               │
└───────▲──────┘   └───────┬──────────────────────────────────┘
        │                  │ BullMQ dequeue
        │         ┌────────▼──────────────────────────────────┐
        │         │        Worker Process (Node.js)            │
        │         │  Separate long-running process             │
        │         │  Orchestrates 6-step analysis pipeline     │
        └─────────┤                                            │
                  │  ┌──────────────────────────────────────┐ │
                  │  │          AI Providers (LLMs)         │ │
                  │  │  OpenAI · Gemini · Claude · Groq     │ │
                  │  └──────────────────────────────────────┘ │
                  └────────────────────────────────────────────┘
```

---

## High-Level Component Breakdown

### 1. Next.js Application (Web Server + UI)
- Serves the React frontend (App Router)
- Exposes REST API routes for all client interactions
- Handles Supabase OAuth callback and session management
- Validates user input, creates DB records, and enqueues background jobs
- Does **not** do any LLM work itself — it only enqueues

### 2. PostgreSQL Database (Supabase-hosted)
- Central data store for all persistent state
- 7 models: User, Company, AnalysisJob, Prompt, Response, ExtractedResult, Metrics, Recommendation, SystemConfig
- Accessed via Prisma ORM
- Uses two connection URLs: transaction pooler (port 6543) for the app, session pooler (port 5432) for migrations

### 3. Redis / Upstash
- Backs the BullMQ job queue
- Stores job state and retry metadata
- Supports both local `redis://` and Upstash `rediss://` (TLS)
- No application data is stored in Redis — only queue metadata

### 4. Worker Process
- A **separate** long-running Node.js process (`npm run worker`)
- Subscribes to the `"analysis"` BullMQ queue
- Executes the full 6-step analysis pipeline per job
- Must be deployed alongside the Next.js app (on Render, Railway, etc. when using Vercel for the web layer)
- Concurrency: 1 job at a time per worker instance

### 5. AI Providers
Four LLM providers are supported, each with web search capability:
| Provider | Search Model | Complete Model | SDK |
|---|---|---|---|
| OpenAI | `gpt-4o` | same | `openai` (Responses API) |
| Gemini | `gemini-2.0-flash` | same | `@google/genai` (Grounding) |
| Claude | `claude-sonnet-4-20250514` | same | `@anthropic-ai/sdk` |
| Groq | `groq/compound` | `llama-3.3-70b-versatile` | `openai` (compatible) |

---

## Deployment Topology

```
Vercel (or any Node host)          Render / Railway / Fly.io
┌─────────────────────┐            ┌────────────────────────┐
│  Next.js App        │            │  Worker Process        │
│  - Web server       │            │  - npm run worker      │
│  - API routes       │            │  - Consumes Redis queue│
│  - Auth handling    │            │  - Writes to Postgres  │
└──────────┬──────────┘            └──────────┬─────────────┘
           │                                  │
           └──────────┬───────────────────────┘
                      │
           ┌──────────▼───────────┐    ┌──────────────────┐
           │  Supabase (Postgres) │    │  Redis / Upstash  │
           └──────────────────────┘    └──────────────────┘
```

Both the web app and the worker must share the same `DATABASE_URL` and `REDIS_URL`.

---

## Key Design Decisions

### Async Processing via BullMQ
Analysis runs can take 30–120 seconds (multiple LLM API calls in parallel). The API route creates a DB record and enqueues a job immediately, returning `{ jobId }` to the browser. The UI polls `/api/analysis/status/[jobId]` every 2 seconds until done. This avoids HTTP timeouts and enables retry logic.

### Provider Abstraction
All four LLMs implement a common `LlmProvider` interface (`search()` + `complete()`). The provider manager handles selection, fallback ordering (Gemini → Groq → OpenAI → Claude for non-search tasks), and admin on/off toggles — callers never reference a specific provider directly.

### Separation of Concerns in the Pipeline
The worker delegates each pipeline step to a dedicated service module:
- `competitor.service` — brand correction + competitor discovery
- `prompt.service` — context building + prompt generation
- `search.service` — fan-out LLM search calls
- `extraction.service` — structured JSON extraction from raw responses
- `metrics.service` — score calculation
- `recommendation.service` — AI report generation

### Public Sharing
Completed analyses are publicly shareable at `/report/[jobId]` with no auth required. The `AnalysisDashboard` component handles both private (polling) and public (single load) modes.

### Unauthenticated Admin
The `/admin` page and `/api/admin/*` routes have **no authentication guard by design**. This is intentional for internal tooling but should be secured before any public-facing production deployment.

---

## Technology Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (App Router) + React 19 |
| Language | TypeScript |
| Auth | Supabase Auth (Google OAuth, cookie sessions) |
| Database | PostgreSQL via Supabase, Prisma ORM |
| Job Queue | BullMQ 5 + ioredis 5 |
| AI SDKs | openai, @google/genai, @anthropic-ai/sdk |
| Validation | Zod |
| Styling | Tailwind CSS 4, DM Sans, Source Serif 4 |
| Markdown | react-markdown + remark-gfm |
| Dev tools | tsx (worker watch), eslint |
