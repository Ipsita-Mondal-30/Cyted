import Link from "next/link";
import type { AuthUser } from "@/lib/auth";

export function AppHeader({ user }: { user: AuthUser | null }) {
  return (
    <header className="border-b border-zinc-800 bg-zinc-950/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="text-sm font-semibold tracking-tight text-white"
          >
            Cyted
          </Link>
          {user && (
            <nav className="flex gap-4 text-sm text-zinc-400">
              <Link href="/" className="hover:text-white">
                New analysis
              </Link>
              <Link href="/dashboard" className="hover:text-white">
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
            <span className="hidden text-sm text-zinc-400 sm:inline">
              {user.name || user.email}
            </span>
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="text-sm text-zinc-500 hover:text-white"
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
