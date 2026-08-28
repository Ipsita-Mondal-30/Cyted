import { prisma } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

function profileFromSupabaseUser(user: {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown>;
}): AuthUser | null {
  if (!user.email) return null;
  const name =
    (user.user_metadata?.full_name as string | undefined) ||
    (user.user_metadata?.name as string | undefined) ||
    null;
  const avatarUrl =
    (user.user_metadata?.avatar_url as string | undefined) ||
    (user.user_metadata?.picture as string | undefined) ||
    null;
  return {
    id: user.id,
    email: user.email,
    name,
    avatarUrl,
  };
}

async function syncUserRow(profile: AuthUser) {
  try {
    await prisma.user.upsert({
      where: { id: profile.id },
      create: {
        id: profile.id,
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
      },
      update: {
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
      },
    });
  } catch {
    // Header/login should still work if Postgres is briefly unavailable.
  }
}

export async function requireUser(): Promise<AuthUser> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const profile = user ? profileFromSupabaseUser(user) : null;
  if (!profile) {
    throw new AuthError("Unauthorized");
  }

  await syncUserRow(profile);
  return profile;
}

export class AuthError extends Error {
  status = 401;
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export async function getOptionalUser(): Promise<AuthUser | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const profile = user ? profileFromSupabaseUser(user) : null;
    if (!profile) return null;
    await syncUserRow(profile);
    return profile;
  } catch {
    return null;
  }
}
