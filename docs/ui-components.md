# UI Components

All components live in `src/components/`. The app uses Next.js App Router with React 19. Components are a mix of server components (pages, layouts) and client components (interactive UI, marked with `"use client"`).

---

## Component Map

```
App Pages (src/app/)
├── page.tsx                  →  Landing page (uses BrandLogoCarousel, AnalyzeForm)
├── login/page.tsx            →  Login page (uses LoginButton)
├── dashboard/page.tsx        →  Analysis history list
├── dashboard/[jobId]/page.tsx →  Active/completed analysis (uses AnalysisDashboard)
├── report/[jobId]/page.tsx   →  Public shareable report (uses AnalysisDashboard mode="public")
└── admin/page.tsx            →  Admin panel (uses AdminProviderToggles)

Shared Components (src/components/)
├── AppHeader.tsx             →  Top navigation bar
├── AnalyzeForm.tsx           →  Company details form
├── AnalysisDashboard.tsx     →  Full report page (private + public modes)
├── ReportRankingHero.tsx     →  Competitor ranking section
├── InsightMetricCard.tsx     →  Individual metric card with tone badge
├── ContentSuggestions.tsx    →  AI-generated content idea grid
├── MarkdownReport.tsx        →  Renders recommendation markdown
├── AiProviderStrip.tsx       →  Provider participation badges
├── BrandLogo.tsx             →  Logo with 3-layer fallback
├── BrandLogoCarousel.tsx     →  Animated brand logo marquee (landing page)
├── CopyReportLink.tsx        →  Clipboard copy button for share URL
└── AdminProviderToggles.tsx  →  Provider on/off toggles (admin page)
```

---

## Component Details

### `AppHeader`

**File**: `src/components/AppHeader.tsx`  
**Type**: Server component (receives user as prop)

Top navigation bar rendered on all authenticated pages. Displays:
- Brand logo / wordmark (links to `/`)
- "New Analysis" link (links to `/`)
- "History" link (links to `/dashboard`)
- User avatar + display name
- Sign out button (triggers `POST /auth/signout`)

Accepts a `user` prop with `{ name, avatarUrl }`. The avatar is shown as an `<img>` with a fallback to initials if the URL fails to load.

---

### `AnalyzeForm`

**File**: `src/components/AnalyzeForm.tsx`  
**Type**: Client component (`"use client"`)

The main input form on the home/landing page. Collects:
- Company name (required text field)
- Website URL (optional)
- Company description (optional textarea)
- Competitors (tag-style multi-input — add/remove individual competitors)

On submit:
1. Validates locally (company name must be non-empty)
2. POSTs to `POST /api/analysis/create`
3. On success: `router.push("/dashboard/" + jobId)`
4. On error: displays inline error message

Pre-fills from the user's existing `Company` record fetched via `GET /api/company` on mount.

---

### `AnalysisDashboard`

**File**: `src/components/AnalysisDashboard.tsx`  
**Type**: Client component (`"use client"`)  
**Props**: `{ jobId: string, mode?: "private" | "public" }`

The most complex component in the app. Handles both the loading/polling state and the full rendered report.

**In `private` mode** (default — `/dashboard/[jobId]`):
- Polls `GET /api/analysis/status/[jobId]` every 2 seconds
- Shows progress bar and `progressMessage`
- When `status === COMPLETED` or `FAILED`, fetches results once and stops polling
- Poll errors double the interval to 4 seconds and keep retrying

**In `public` mode** (`/report/[jobId]`):
- Loads `GET /api/public/report/[jobId]` once on mount (no polling — the job is already complete)
- Hides raw prompt/response rows

**When results are loaded**, renders:
1. Company name header + `CopyReportLink` (private mode only)
2. `AiProviderStrip` — which providers ran
3. `ReportRankingHero` — competitor share of voice ranking
4. 4× `InsightMetricCard` — Visibility Score, Positive Sentiment Rate, Citation Share, Recommendation Rate
5. 3 mini-stat badges — Share of Voice, Mention Rate, Avg Ranking
6. Competitor share of voice bar chart with `BrandLogo` icons
7. `ContentSuggestions` — AI content ideas grid
8. `MarkdownReport` — full strategic markdown report
9. Expandable prompt rows (private only) — each prompt's raw AI responses with extraction metadata

---

### `ReportRankingHero`

**File**: `src/components/ReportRankingHero.tsx`  
**Type**: Client component

Hero section at the top of the report. Displays all brands (company + competitors) ranked by share of voice as a visual leaderboard. Each brand shows:
- Rank number (1st, 2nd, 3rd, etc.)
- `BrandLogo` icon
- Brand name
- Share of voice percentage as a horizontal bar

The target company is highlighted distinctly from competitors.

---

### `InsightMetricCard`

**File**: `src/components/InsightMetricCard.tsx`  
**Type**: Client component  
**Exports**: `InsightMetricCard`, `scoreTone`, `MetricTone`

Displays one key metric as a card with:
- Metric label
- Large numeric value (formatted as percentage or decimal)
- Tone badge: `Poor` / `Fair` / `Good` with corresponding color (red / amber / green)
- Optional subtitle or description

The `scoreTone(value, thresholds)` utility determines the tone based on configurable low/high thresholds. Used for Visibility Score, Positive Sentiment Rate, Citation Share, and Recommendation Rate.

```typescript
// Example: Visibility Score
scoreTone(72.4, { low: 40, high: 65 }) // → "Good" (green)
scoreTone(35.0, { low: 40, high: 65 }) // → "Poor" (red)
scoreTone(50.0, { low: 40, high: 65 }) // → "Fair" (amber)
```

---

### `ContentSuggestions`

**File**: `src/components/ContentSuggestions.tsx`  
**Type**: Client component

Renders the AI-generated content improvement suggestions from `Recommendation.contentSuggestions`. Displays a grid of suggestion cards, each showing:
- Content type (e.g. "Comparison Article", "How-To Guide", "Listicle")
- Suggested title
- Rationale (why this content would improve AEO)
- Target keywords
- Estimated impact badge (High / Medium / Low)

Receives `suggestions: ContentSuggestion[]` as props. Falls back gracefully if the array is empty.

---

### `MarkdownReport`

**File**: `src/components/MarkdownReport.tsx`  
**Type**: Client component

Renders the `recommendation.markdown` string as formatted HTML using `react-markdown` with the `remark-gfm` plugin (GitHub Flavored Markdown — tables, strikethrough, task lists).

Custom component overrides apply Tailwind CSS classes to standard markdown elements (`h1`–`h4`, `p`, `ul`, `ol`, `li`, `strong`, `blockquote`, `code`, `table`, etc.) to match the app's design system. Uses **Source Serif 4** for report body text.

---

### `AiProviderStrip`

**File**: `src/components/AiProviderStrip.tsx`  
**Type**: Client component (or server — no interactivity)

A horizontal strip of labeled badges showing which AI providers participated in an analysis. Providers are shown as colored icon+label pills (e.g. "OpenAI", "Gemini", "Claude", "Groq"). Receives `providers: string[]` as props.

---

### `BrandLogo`

**File**: `src/components/BrandLogo.tsx`  
**Type**: Client component (`"use client"`)  
**Props**: `{ name: string, domain?: string, logoUrl?: string, size?: number }`

Displays a brand logo with a 3-layer fallback chain:

```
1. logoUrl (Clearbit CDN URL from companyContext.brandLogos)
        │ onError
        ▼
2. Google Favicon API: https://www.google.com/s2/favicons?sz=64&domain={domain}
        │ onError
        ▼
3. 2-letter initials in a zinc-colored box (always works)
```

The fallback chain is handled purely client-side via React `onError` state on the `<img>` element.

---

### `BrandLogoCarousel`

**File**: `src/components/BrandLogoCarousel.tsx`  
**Type**: Client component

An animated 3-row marquee of well-known brand logos shown on the home/landing page. Logos scroll in alternating directions (left/right) to create a dynamic background effect. Uses CSS `animation` with `transform: translateX()`.

This is purely decorative — demonstrates that well-known brands can be analyzed. Brand list is hardcoded in the component.

---

### `CopyReportLink`

**File**: `src/components/CopyReportLink.tsx`  
**Type**: Client component (`"use client"`)

A small "Copy link" button that copies the public report URL (`/report/[jobId]`) to the clipboard using the `navigator.clipboard` API. Shows a brief "Copied!" confirmation state after clicking. Only rendered in private mode (the dashboard view).

---

### `AdminProviderToggles`

**File**: `src/components/AdminProviderToggles.tsx`  
**Type**: Client component (`"use client"`)

The interactive section of the `/admin` page. On mount, fetches `GET /api/admin/providers` to get current provider states. Renders a toggle switch for each provider showing:
- Provider name and model
- Whether the API key is present (read-only indicator)
- Enable/disable toggle (calls `PUT /api/admin/providers` on change)
- Active status badge

Changes take effect immediately for newly queued analysis jobs.

---

## Styling Conventions

- **Tailwind CSS 4** — utility-first, no separate CSS files per component
- **DM Sans** — primary UI font (labels, buttons, stats, navigation)
- **Source Serif 4** — report body font (used in `MarkdownReport`)
- Colors follow a neutral zinc palette with semantic green/amber/red for metric tones
- Dark mode is not implemented — the UI is light-mode only

---

## Client vs Server Component Split

| Component | Type | Why |
|---|---|---|
| `AppHeader` | Server | Static nav, user data passed as prop |
| `AnalyzeForm` | Client | Form state, router navigation |
| `AnalysisDashboard` | Client | Polling, `useEffect`, `useState` |
| `ReportRankingHero` | Client | Interactive ranking display |
| `InsightMetricCard` | Client | Dynamic tone calculation |
| `ContentSuggestions` | Client | Dynamic grid rendering |
| `MarkdownReport` | Client | `react-markdown` renders client-side |
| `AiProviderStrip` | Client | Badge rendering |
| `BrandLogo` | Client | `onError` fallback requires DOM events |
| `BrandLogoCarousel` | Client | CSS animation state |
| `CopyReportLink` | Client | `navigator.clipboard` API |
| `AdminProviderToggles` | Client | Fetches data, toggle state |
