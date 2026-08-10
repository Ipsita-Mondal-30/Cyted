import { PrismaClient } from "@prisma/client";
import { withRetries } from "@/lib/utils/retries";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaWriteSlots: { active: number; waiters: Array<() => void> };
};

function withPoolLimits(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has("connection_limit")) {
      u.searchParams.set("connection_limit", "5");
    }
    if (!u.searchParams.has("pool_timeout")) {
      u.searchParams.set("pool_timeout", "20");
    }
    return u.toString();
  } catch {
    return url;
  }
}

function createClient() {
  const url = withPoolLimits(process.env.DATABASE_URL);
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    datasources: url ? { db: { url } } : undefined,
  });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

if (!globalForPrisma.prismaWriteSlots) {
  globalForPrisma.prismaWriteSlots = { active: 0, waiters: [] };
}

const MAX_PARALLEL_WRITES = 2;

function isConnectionError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /Server has closed the connection|ConnectionAborted|connection abort|Can't reach database|P1001|P1017|ECONNRESET|ECONNABORTED|timed out/i.test(
    msg
  );
}

async function acquireWriteSlot(): Promise<void> {
  const slots = globalForPrisma.prismaWriteSlots;
  if (slots.active < MAX_PARALLEL_WRITES) {
    slots.active += 1;
    return;
  }
  await new Promise<void>((resolve) => slots.waiters.push(resolve));
  slots.active += 1;
}

function releaseWriteSlot(): void {
  const slots = globalForPrisma.prismaWriteSlots;
  slots.active = Math.max(0, slots.active - 1);
  const next = slots.waiters.shift();
  if (next) next();
}

/** Reconnect Prisma after pooler drops idle/aborted connections. */
export async function ensurePrismaConnected(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    await prisma.$disconnect().catch(() => undefined);
    await prisma.$connect();
  }
}

/**
 * Prisma write with reconnect retries and a small write concurrency cap
 * so parallel LLM workers don't stampede the Supabase pooler.
 */
export async function prismaWrite<T>(fn: () => Promise<T>): Promise<T> {
  await acquireWriteSlot();
  try {
    return await withRetries(
      async () => {
        try {
          return await fn();
        } catch (error) {
          if (isConnectionError(error)) {
            await prisma.$disconnect().catch(() => undefined);
            await new Promise((r) => setTimeout(r, 300));
            await prisma.$connect();
          }
          throw error;
        }
      },
      4,
      "prisma-write"
    );
  } finally {
    releaseWriteSlot();
  }
}
