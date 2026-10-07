import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { createLogger } from "@/lib/logger";
import { getJobRunMode } from "@/lib/services/provider-settings.service";
import { enqueueAnalysis } from "@/queue/queue";

const log = createLogger("api:create");

const bodySchema = z.object({
  companyName: z.string().min(1, "Company name is required"),
  website: z.string().url().optional().or(z.literal("")).nullable(),
  description: z.string().optional().nullable(),
  competitors: z.array(z.string()).optional().default([]),
});

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const json = await request.json();
    const parsed = bodySchema.safeParse(json);

    if (!parsed.success) {
      log.warn("Invalid create body", parsed.error.flatten());
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "Invalid body" },
        { status: 400 }
      );
    }

    const companyName = parsed.data.companyName.trim();
    const website = parsed.data.website?.trim() || null;
    const description = parsed.data.description?.trim() || null;
    const competitors = (parsed.data.competitors || [])
      .map((c) => c.trim())
      .filter(Boolean);

    log.info("Creating analysis", {
      userId: user.id,
      companyName,
      competitors,
    });

    const company = await prisma.company.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        name: companyName,
        website,
        description,
        competitors,
      },
      update: {
        name: companyName,
        website,
        description,
        competitors,
      },
    });
    log.info("Company upserted", { companyId: company.id, userId: user.id });

    const analysis = await prisma.analysisJob.create({
      data: {
        userId: user.id,
        companyId: company.id,
        companyName,
        website,
        description,
        competitors,
        status: "QUEUED",
        progress: 0,
        progressMessage: "Queued — waiting for worker",
      },
    });
    log.info("AnalysisJob created", {
      analysisId: analysis.id,
      status: analysis.status,
    });

    // Direct mode: the QUEUED row is the job — the worker polls Postgres for it.
    if ((await getJobRunMode()) === "queue") {
      await enqueueAnalysis(analysis.id);
      log.info("Analysis handed to BullMQ — ensure `npm run worker` is running", {
        analysisId: analysis.id,
      });
    } else {
      log.info("Analysis queued in Postgres (direct mode) — worker will poll it", {
        analysisId: analysis.id,
      });
    }

    return NextResponse.json({ jobId: analysis.id });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    log.error("Failed to create analysis", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create analysis" },
      { status: 500 }
    );
  }
}
