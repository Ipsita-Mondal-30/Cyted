import { prisma } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

export async function requireUser(): Promise<AuthUser> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !user.email) {
    throw new AuthError("Unauthorized");
  }

  const name =
    (user.user_metadata?.full_name as string | undefined) ||
    (user.user_metadata?.name as string | undefined) ||
    null;
  const avatarUrl =
    (user.user_metadata?.avatar_url as string | undefined) ||
    (user.user_metadata?.picture as string | undefined) ||
    null;

  await prisma.user.upsert({
    where: { id: user.id },
    create: {
      id: user.id,
      email: user.email,
      name,
      avatarUrl,
    },
    update: {
      email: user.email,
      name,
      avatarUrl,
    },
  });

  return {
    id: user.id,
    email: user.email,
    name,
    avatarUrl,
  };
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
    return await requireUser();
  } catch {
    return null;
  }
}
