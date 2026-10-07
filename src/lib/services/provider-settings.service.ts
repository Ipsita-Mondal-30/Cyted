import { prisma } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import type { ProviderName } from "@/lib/providers/types";

const log = createLogger("service:provider-settings");

export type ProviderFlags = Record<ProviderName, boolean>;

export const DEFAULT_PROVIDER_FLAGS: ProviderFlags = {
  openai: true,
  gemini: true,
  claude: true,
  groq: true,
};

const SETTINGS_ID = "default";

export async function getProviderFlags(): Promise<ProviderFlags> {
  try {
    const row = await prisma.systemConfig.findUnique({
      where: { id: SETTINGS_ID },
    });
    if (!row?.enabledProviders) return { ...DEFAULT_PROVIDER_FLAGS };
    const raw = row.enabledProviders as Partial<ProviderFlags>;
    return {
      ...DEFAULT_PROVIDER_FLAGS,
      ...raw,
    };
  } catch (error) {
    log.warn("Could not load provider flags — using defaults", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...DEFAULT_PROVIDER_FLAGS };
  }
}

export async function setProviderFlags(
  patch: Partial<ProviderFlags>
): Promise<ProviderFlags> {
  const current = await getProviderFlags();
  const next: ProviderFlags = { ...current, ...patch };

  await prisma.systemConfig.upsert({
    where: { id: SETTINGS_ID },
    create: {
      id: SETTINGS_ID,
      enabledProviders: next,
    },
    update: {
      enabledProviders: next,
    },
  });

  log.info("Provider flags updated", next);
  return next;
}

export function isProviderEnabledInFlags(
  flags: ProviderFlags,
  name: ProviderName
): boolean {
  return flags[name] !== false;
}

/** How analyses reach the worker: poll Postgres directly, or BullMQ over Redis. */
export type JobRunMode = "direct" | "queue";

export const DEFAULT_JOB_RUN_MODE: JobRunMode = "direct";

/** Throws on DB errors — callers that must not flip modes on a blip use this. */
export async function readJobRunMode(): Promise<JobRunMode> {
  const row = await prisma.systemConfig.findUnique({
    where: { id: SETTINGS_ID },
    select: { jobRunMode: true },
  });
  return row?.jobRunMode === "queue" ? "queue" : DEFAULT_JOB_RUN_MODE;
}

export async function getJobRunMode(): Promise<JobRunMode> {
  try {
    return await readJobRunMode();
  } catch (error) {
    log.warn("Could not load job run mode — using default", {
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_JOB_RUN_MODE;
  }
}

export async function setJobRunMode(mode: JobRunMode): Promise<JobRunMode> {
  await prisma.systemConfig.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, jobRunMode: mode },
    update: { jobRunMode: mode },
  });
  log.info("Job run mode updated", { mode });
  return mode;
}
