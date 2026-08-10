import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { createLogger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const log = createLogger("api:status");

function databaseHost(): string {
  try {
    return new URL(process.env.DATABASE_URL || "").hostname || "unknown";
  } catch {
    return "unknown";
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> }
) {
  try {
    const user = await requireUser();
    const { jobId } = await context.params;

    // Bypass any accidental query caching; always hit Postgres
    const job = await prisma.analysisJob.findFirst({
      where: { id: jobId, userId: user.id },
      select: {
        id: true,
        status: true,
        progress: true,
        progressMessage: true,
        error: true,
        warnings: true,
        companyName: true,
        createdAt: true,
        completedAt: true,
      },
    });

    if (!job) {
      log.warn("Status job not found", {
        jobId,
        userId: user.id,
        dbHost: databaseHost(),
      });
      return NextResponse.json(
        { error: "Not found", dbHost: databaseHost() },
        {
          status: 404,
          headers: {
            "Cache-Control": "no-store, no-cache, must-revalidate",
          },
        }
      );
    }

    log.info("Status poll", {
      jobId,
      status: job.status,
      progress: job.progress,
      progressMessage: job.progressMessage,
      dbHost: databaseHost(),
    });

    return NextResponse.json(
      {
        ...job,
        // Helps confirm Vercel and Render share the same Postgres
        dbHost: databaseHost(),
        polledAt: new Date().toISOString(),
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
          Pragma: "no-cache",
        },
      }
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    log.error("Status fetch failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Failed to fetch status" }, { status: 500 });
  }
}
