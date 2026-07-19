import Link from "next/link";
import type { AuthUser } from "@/lib/auth";

export function AppHeader({ user }: { user: AuthUser | null }) {
  return (
    <header className="border-b border-stone-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-sm font-semibold tracking-tight text-stone-900">
            Cyted
          </Link>
          {user && (
            <nav className="flex gap-4 text-sm text-stone-600">
              <Link href="/" className="hover:text-stone-900">
                New analysis
              </Link>
              <Link href="/dashboard" className="hover:text-stone-900">
                History
              </Link>
            </nav>
          )}
        </div>
        {user && (
          <div className="flex items-center gap-3">
            {user.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.avatarUrl}
                alt=""
                className="h-8 w-8 rounded-full"
                referrerPolicy="no-referrer"
              />
            ) : null}
            <span className="hidden text-sm text-stone-600 sm:inline">
              {user.name || user.email}
            </span>
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="text-sm text-stone-500 hover:text-stone-900"
              >
                Sign out
              </button>
            </form>
          </div>
        )}
      </div>
    </header>
  );
}
