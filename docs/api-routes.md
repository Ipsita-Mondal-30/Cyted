# API Routes

All routes live under `src/app/api/` and follow Next.js App Router conventions. Each folder maps directly to a URL path and exports named handler functions (`GET`, `POST`, `PUT`).

---

## Route Map

```
/api
├── analysis
│   ├── create              POST   Create a new analysis job
│   ├── status/[jobId]      GET    Poll job progress
│   └── results/[jobId]     GET    Fetch completed results
├── company                 GET    Get the current user's company profile
├── admin
│   ├── providers           GET    List AI provider states
│   │                       PUT    Toggle a provider on/off
│   └── usage               GET    Aggregate usage & cost report
├── public
│   └── report/[jobId]      GET    Public (unauthenticated) report fetch
└── auth
    ├── callback            GET    OAuth code exchange (Supabase)
    └── signout             POST   Sign the user out
```

---

## Analysis Routes

### `POST /api/analysis/create`

**File**: `src/app/api/analysis/create/route.ts`  
**Auth**: Required

Creates a new analysis job and enqueues it for background processing.

**Request body**:
```json
{
  "companyName": "Acme Corp",       // required
  "website": "https://acme.com",   // optional
  "description": "We make...",     // optional
  "competitors": ["Rival", "Other"] // optional, array of strings
}
```

**Validation**: Zod schema. `companyName` must be a non-empty string. `competitors` defaults to `[]`.

**Processing sequence**:
1. Calls `requireUser()` — validates session, upserts `User` row
2. Upserts `Company` for the user (`userId` is unique — one company per user)
3. Creates `AnalysisJob` with `status: QUEUED`, snapshots all input fields
4. Calls `enqueueAnalysis(analysisId)` — adds a BullMQ job to the `"analysis"` queue
5. Returns `{ jobId }`

**Response**:
```json
{ "jobId": "clxyz123..." }
```

**Error responses**:
| Status | Condition |
|---|---|
| 401 | Not authenticated |
| 400 | Validation failure (e.g. missing companyName) |
| 500 | Database or queue error |

---

### `GET /api/analysis/status/[jobId]`

**File**: `src/app/api/analysis/status/[jobId]/route.ts`  
**Auth**: Required  
**Caching**: `force-dynamic` — never cached

Returns the current status and progress of a job. Polled by the UI every 2 seconds during processing.

**URL param**: `jobId` — the `AnalysisJob.id`

**Auth scope**: The job's `userId` must match the authenticated user. Returns 404 if the job doesn't exist or belongs to another user.

**Response**:
```json
{
  "id": "clxyz123...",
  "status": "PROCESSING",
  "progress": 65,
  "progressMessage": "Searching AI providers (8/12)",
  "error": null,
  "warnings": [],
  "companyName": "Acme Corp",
  "createdAt": "2026-08-28T10:00:00.000Z",
  "completedAt": null,
  "dbHost": "db.supabase.co",
  "polledAt": "2026-08-28T10:01:30.000Z"
}
```

`dbHost` and `polledAt` are diagnostic fields included for debugging connection issues. The UI shows `dbHost` in error messages.

**Error responses**:
| Status | Condition |
|---|---|
| 401 | Not authenticated |
| 404 | Job not found or belongs to another user |

---

### `GET /api/analysis/results/[jobId]`

**File**: `src/app/api/analysis/results/[jobId]/route.ts`  
**Auth**: Required  
**Caching**: `force-dynamic` — never cached

Returns the full analysis result including all metrics, prompts, responses, extractions, and the recommendation report. Called once when the UI detects `status === "COMPLETED"` or `"FAILED"`.

**URL param**: `jobId`

**Auth scope**: Scoped to the authenticated user.

**Processing**: Fetches the `AnalysisJob` with all relations (`metrics`, `recommendation`, `prompts → responses → extracted`) then passes through `serializeAnalysisReport()` which:
- Extracts `__positiveSentimentRate` from `competitorShare` and surfaces it separately
- Rebuilds `brandLogos` from `companyContext.brandLogos` (Clearbit CDN URLs)
- Parses `Recommendation.content` JSON
- Flattens the nested Prisma response into a clean API shape

**Response** (abbreviated):
```json
{
  "id": "clxyz123...",
  "companyName": "Acme Corp",
  "website": "https://acme.com",
  "competitors": ["Rival", "Other"],
  "brandLogos": { "Acme Corp": "https://logo.clearbit.com/acme.com" },
  "brandDomains": { "Acme Corp": "acme.com" },
  "providers": ["openai", "gemini", "claude", "groq"],
  "status": "COMPLETED",
  "progress": 100,
  "progressMessage": "Done",
  "error": null,
  "warnings": [],
  "metrics": {
    "visibilityScore": 72.4,
    "mentionRate": 83.3,
    "shareOfVoice": 41.2,
    "citationRate": 55.0,
    "recommendationRate": 66.7,
    "avgRanking": 1.8,
    "positiveSentimentRate": 68.0,
    "competitorShare": { "Rival": 0.35, "Other": 0.24 }
  },
  "recommendation": {
    "markdown": "## Strategic Report\n\n...",
    "contentSuggestions": [
      {
        "type": "Comparison Article",
        "title": "Acme vs Rival: Which is right for you?",
        "rationale": "...",
        "keywords": ["acme vs rival"],
        "estimatedImpact": "High"
      }
    ]
  },
  "prompts": [
    {
      "id": "...",
      "category": "Comparison",
      "prompt": "Compare Acme Corp vs Rival for small teams",
      "responses": [
        {
          "id": "...",
          "provider": "openai",
          "model": "gpt-4o",
          "rawResponse": "Acme Corp is a leading...",
          "latencyMs": 2341,
          "error": null,
          "extracted": {
            "mentionedBrands": ["Acme Corp", "Rival"],
            "ranking": 1,
            "sentiment": "Positive",
            "reasoning": "Acme was recommended first"
          }
        }
      ]
    }
  ]
}
```

**Error responses**:
| Status | Condition |
|---|---|
| 401 | Not authenticated |
| 404 | Job not found or belongs to another user |

---

## Company Route

### `GET /api/company`

**File**: `src/app/api/company/route.ts`  
**Auth**: Required

Returns the authenticated user's `Company` record. Used to pre-fill the `AnalyzeForm` with data from the previous analysis run.

**Response**:
```json
{
  "id": "clcomp123...",
  "name": "Acme Corp",
  "website": "https://acme.com",
  "description": "We make CRM software...",
  "competitors": ["Rival", "Other"]
}
```

Returns `null` (with 200 status) if the user has no company yet.

**Error responses**:
| Status | Condition |
|---|---|
| 401 | Not authenticated |

---

## Admin Routes

> **Security note**: These routes have **no authentication guard**. They are intended for internal use only and should be protected at the infrastructure level (e.g. IP allowlist, VPN, basic auth via reverse proxy) before public-facing production deployment.

### `GET /api/admin/providers`

**File**: `src/app/api/admin/providers/route.ts`  
**Auth**: None

Returns the current state of all four AI providers — whether their API key is set, whether they're enabled in the admin toggle, and whether they're actively usable.

**Response**:
```json
[
  {
    "name": "openai",
    "label": "OpenAI",
    "model": "gpt-4o",
    "keyPresent": true,
    "enabled": true,
    "active": true
  },
  {
    "name": "gemini",
    "label": "Google Gemini",
    "model": "gemini-2.0-flash",
    "keyPresent": true,
    "enabled": true,
    "active": true
  },
  {
    "name": "claude",
    "label": "Anthropic Claude",
    "model": "claude-sonnet-4-20250514",
    "keyPresent": false,
    "enabled": true,
    "active": false
  },
  {
    "name": "groq",
    "label": "Groq",
    "model": "groq/compound",
    "keyPresent": true,
    "enabled": false,
    "active": false
  }
]
```

Field semantics:
- `keyPresent` — the API key env var is set and non-empty
- `enabled` — the admin toggle in `SystemConfig.enabledProviders` is `true` (or absent, which defaults to `true`)
- `active` — `keyPresent && enabled` — this is what actually controls whether the provider runs

---

### `PUT /api/admin/providers`

**File**: `src/app/api/admin/providers/route.ts`  
**Auth**: None

Toggles one or more providers on or off. Writes to `SystemConfig.enabledProviders` in the database. Takes effect immediately for all subsequent analysis jobs (provider flags are read fresh per job).

**Request body**:
```json
{
  "enabledProviders": {
    "openai": true,
    "gemini": true,
    "claude": false,
    "groq": true
  }
}
```

Partial updates are fine — only the keys you send are merged. Omitted providers retain their current value.

**Response**: `204 No Content`

**Error responses**:
| Status | Condition |
|---|---|
| 400 | Invalid body shape |

---

### `GET /api/admin/usage`

**File**: `src/app/api/admin/usage/route.ts`  
**Auth**: None

Returns an aggregate usage and cost report across all analysis jobs and all responses. Useful for monitoring LLM spend and job health.

**Processing**: Calls `loadAdminUsage()` in `src/lib/admin-usage.ts` which:
- Counts totals: users, companies, analyses, by-status breakdown
- Loads all `Response` rows and estimates tokens as `text.length / 4`
- Looks up per-model pricing from `src/lib/ai-pricing.ts` (exact match → prefix regex → provider default)
- Aggregates per-provider: call count, success rate, avg latency, total cost
- Breaks down further by model within each provider
- Returns the 25 most recent `AnalysisJob` rows with per-job cost estimates

> **Cost accuracy note**: Only the LLM calls stored as `Response` rows are counted. Extraction and recommendation calls (which use `completePreferringGemini`) are not stored as `Response` rows, so actual spend is higher than reported.

**Response** (abbreviated):
```json
{
  "totals": {
    "users": 12,
    "companies": 12,
    "analyses": 48,
    "byStatus": { "COMPLETED": 44, "FAILED": 3, "QUEUED": 1 },
    "totalCost": 2.34,
    "totalCalls": 1920,
    "successRate": 96.2
  },
  "providers": [
    {
      "name": "openai",
      "calls": 576,
      "successRate": 98.1,
      "avgLatencyMs": 2100,
      "estimatedCost": 0.87,
      "models": [
        {
          "model": "gpt-4o",
          "calls": 576,
          "estimatedCost": 0.87
        }
      ]
    }
  ],
  "recentAnalyses": [
    {
      "id": "clxyz...",
      "companyName": "Acme Corp",
      "status": "COMPLETED",
      "createdAt": "2026-08-28T10:00:00.000Z",
      "estimatedCost": 0.052,
      "dashboardUrl": "/dashboard/clxyz..."
    }
  ]
}
```

---

## Public Routes

### `GET /api/public/report/[jobId]`

**File**: `src/app/api/public/report/[jobId]/route.ts`  
**Auth**: None  
**Caching**: `public, s-maxage=60, stale-while-revalidate=300`

Returns the full results for a completed analysis. Used by the public `/report/[jobId]` page (shareable links). Only returns jobs with `status === "COMPLETED"` — in-progress or failed jobs return 404.

The response shape is identical to `GET /api/analysis/results/[jobId]` but:
- No auth required
- Cached at the CDN/edge for 60 seconds (stale-while-revalidate for 5 minutes)
- Raw `responses[].rawResponse` text is still included (same serializer)

**Error responses**:
| Status | Condition |
|---|---|
| 404 | Job not found or not yet completed |

---

## Auth Routes

### `GET /auth/callback`

**File**: `src/app/auth/callback/route.ts`  
**Auth**: None (this IS the auth handler)

Handles the OAuth redirect from Supabase after Google login. Exchanges the one-time `code` param for a session.

**Query params**: `code` (from Supabase), `next` (optional redirect destination)

**Processing sequence**:
1. Creates a Supabase server client with cookie access
2. Calls `supabase.auth.exchangeCodeForSession(code)`
3. On success: reads `auth_next` cookie or `?next=` param for post-login destination
4. Upserts the `User` row in Postgres with `name` and `avatarUrl` from Google metadata
5. Deletes the `auth_next` cookie
6. Redirects to the destination path (validated to start with `/` and not `//`)

**On failure**: redirects to `/login?error=...`

---

### `POST /auth/signout`

**File**: `src/app/auth/signout/route.ts`  
**Auth**: Session cookie (not strictly required — safe to call even if not logged in)

Signs the user out by calling `supabase.auth.signOut()`, which clears the session cookie.

**Response**: Redirect to `/`

---

## Common Patterns

### Authentication (`requireUser`)

All protected routes call `requireUser(request)` from `src/lib/auth.ts`. This function:
1. Creates a Supabase server client from request cookies
2. Calls `supabase.auth.getUser()` — **network-validated** (not just a cookie read)
3. Extracts `name` and `avatarUrl` from `user_metadata`
4. Upserts the `User` row in Postgres (so it stays in sync with Google OAuth data)
5. Returns `{ id, email, name, avatarUrl }`
6. Throws `AuthError` (401) if the session is invalid or absent

### Route Protection Summary

| Route pattern | Auth required | Notes |
|---|---|---|
| `/api/analysis/*` | Yes | Scoped to `userId` |
| `/api/company` | Yes | Returns user's company |
| `/api/admin/*` | No | Internal tooling only |
| `/api/public/*` | No | Cached, COMPLETED jobs only |
| `/auth/callback` | No | Auth handler itself |
| `/auth/signout` | No | Safe to call unauthenticated |
