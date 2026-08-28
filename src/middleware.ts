import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

const PUBLIC_PATHS = [
  "/",
  "/login",
  "/auth/callback",
  "/admin",
  "/report",
];

const PUBLIC_PREFIXES = ["/api/admin", "/api/public"];

function isPublicPath(pathname: string): boolean {
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return true;
  }
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return true;
  }
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return true;
  }
  return false;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // API routes authenticate in route handlers (requireUser) — skip edge auth
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Public pages: no Supabase call (avoids slow/hanging getUser on every hit)
  if (isPublicPath(pathname) && pathname !== "/login") {
    return NextResponse.next();
  }

  const { supabaseResponse, user } = await updateSession(request);

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  if (!user && !isPublicPath(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Run on page routes only — not /api (handlers auth themselves) or static assets.
     */
    "/((?!api/|_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
