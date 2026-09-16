# Authentication Flow

Authentication is handled by **Supabase Auth** using Google OAuth. Sessions are managed via HTTP cookies using `@supabase/ssr`. The database has a separate `User` table in PostgreSQL that mirrors Supabase Auth users.

---

## Auth Architecture

```
Supabase Auth (hosted)         Next.js App              PostgreSQL (Supabase)
        │                          │                            │
        │   Google OAuth           │                            │
        │◄─────────────────────────│                            │
        │──────────────────────────►│                            │
        │                          │── upsert User row ────────►│
        │                          │   (on every login)         │
        │   Session cookie         │                            │
        │◄─────────────────────────│                            │
        │                          │                            │
```

There are two distinct "user" representations:
1. **Supabase Auth user** — managed by Supabase, validated via `supabase.auth.getUser()` (network call)
2. **Prisma `User` row** — in PostgreSQL, synced from Supabase on every login and every authenticated API call

---

## Login Flow

```
1. User visits /login (or is redirected there by middleware)
         │
         ▼
2. User clicks "Sign in with Google"
   LoginButton calls:
   supabase.auth.signInWithOAuth({
     provider: "google",
     options: {
       redirectTo: origin + "/auth/callback"
     }
   })
   Before redirecting, saves the destination path in an "auth_next" cookie
   (so the user lands back where they were after login)
         │
         ▼
3. Browser redirects to Google OAuth consent screen
         │
         ▼
4. User grants permission → Google redirects to Supabase
         │
         ▼
5. Supabase redirects to /auth/callback?code=<one-time-code>
         │
         ▼
6. GET /auth/callback handler:
   a. supabase.auth.exchangeCodeForSession(code)
      → sets session cookie on the response
   b. Reads auth_next cookie or ?next= query param for destination
   c. Upserts User row in PostgreSQL:
      { id: user.id, email, name, avatarUrl }
      (name and avatarUrl from user.user_metadata.full_name / avatar_url)
   d. Deletes the auth_next cookie
   e. Redirects to destination path (validated: must start with "/" not "//")
         │
         ▼
7. User arrives at their destination, authenticated
```

---

## Session Management (Middleware)

**File**: `src/middleware.ts`

The middleware runs on every request (except static assets). It calls `updateSession()` from `src/lib/supabase/middleware.ts`.

`updateSession()` does:
1. Reads the session from cookies (`getSession()` — **local cookie read, no network call**)
2. If the session is about to expire, refreshes it (network call to Supabase)
3. Updates the response cookies with the refreshed session

**Route protection**: After updating the session, the middleware checks if the current path is a protected page. If the user is not authenticated and the path is protected, it redirects to `/login?next=[pathname]`.

### Public paths (exempt from auth redirect):
```
/                        Home / landing page
/login                   Login page
/auth/callback           OAuth handler
/auth/signout            Sign out
/admin                   Admin panel (unauthenticated by design)
/report/*                Public shareable reports
/api/admin/*             Admin API endpoints
/api/public/*            Public report API
```

### Protected paths (redirect to login if not authenticated):
```
/dashboard               Analysis history
/dashboard/*             Individual analysis pages
/api/analysis/*          Analysis API routes
/api/company             Company profile API
```

---

## API Route Authentication (`requireUser`)

**File**: `src/lib/auth.ts`

All protected API routes call `requireUser(request)` at the top of the handler. Unlike the middleware which uses a local cookie read, `requireUser()` always makes a **network call to Supabase** to validate the session token. This is more secure — it can't be fooled by a tampered or expired cookie.

```typescript
export async function requireUser(request: NextRequest): Promise<AuthUser> {
  const supabase = createServerClient(request);
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    throw new AuthError("Not authenticated"); // → 401
  }

  // Sync User row with latest Google profile data
  const name = user.user_metadata?.full_name ?? user.email ?? "User";
  const avatarUrl = user.user_metadata?.avatar_url ?? null;

  await prisma.user.upsert({
    where: { id: user.id },
    update: { name, avatarUrl, email: user.email! },
    create: { id: user.id, email: user.email!, name, avatarUrl }
  });

  return { id: user.id, email: user.email!, name, avatarUrl };
}
```

The upsert ensures the `User` row in PostgreSQL always reflects the current Google profile data.

---

## Sign Out Flow

```
User clicks "Sign out" in AppHeader
         │
         ▼
Browser POSTs to /auth/signout
         │
         ▼
supabase.auth.signOut()
  → clears session cookie
         │
         ▼
Redirect to /
```

---

## Supabase Client Factories

**Directory**: `src/lib/supabase/`

There are different Supabase client factories for different contexts:

| Factory | Used in | Notes |
|---|---|---|
| `createServerClient(request)` | API route handlers | Has access to request cookies for reading/writing session |
| `createMiddlewareClient(request, response)` | Middleware | Handles cookie passing through the middleware response |
| `createBrowserClient()` | Client components | Browser-side, uses `NEXT_PUBLIC_SUPABASE_*` env vars |

The `@supabase/ssr` package handles cookie-based session management automatically. Session tokens are stored as cookies, not in `localStorage`, which means they work correctly in SSR contexts.

---

## Auth Data Flow Between Supabase and PostgreSQL

```
Supabase Auth                    PostgreSQL User table
─────────────────                ─────────────────────────────
user.id (UUID)          ────►    User.id (UUID, @db.Uuid)
user.email              ────►    User.email
user_metadata.full_name ────►    User.name
user_metadata.avatar_url────►    User.avatarUrl
```

The sync happens at two points:
1. `GET /auth/callback` — immediately after OAuth code exchange
2. Every `requireUser()` call — on every authenticated API request

This means if a user updates their Google profile (name, photo), the change will be reflected in the app the next time they make any authenticated request.

---

## Security Notes

### What is protected
- All `/api/analysis/*` and `/api/company` routes require authentication via `requireUser()`
- The middleware redirects unauthenticated users away from `/dashboard*`
- Jobs are scoped to `userId` — a user can only read their own jobs

### What is NOT protected (by design)
- `/admin` page and `/api/admin/*` routes have **no auth guard**
- `/api/public/report/[jobId]` — intentionally public for sharing
- The admin password is no password — this is acceptable for an internal tool but must be addressed before public production deployment

### Session token validation
- Middleware uses `getSession()` (local cookie read) — fast but does not validate token freshness against Supabase
- API routes use `getUser()` (network call) — validates the token against Supabase's server, catching expired or revoked tokens

This split is intentional: middleware prioritizes speed (it runs on every request), while API routes prioritize security.
