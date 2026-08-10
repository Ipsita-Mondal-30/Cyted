import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> }
) {
  try {
    const user = await requireUser();
    const { jobId } = await context.params;

    const job = await prisma.analysisJob.findFirst({
      where: { id: jobId, userId: user.id },
      include: {
        metrics: true,
        recommendation: true,
        prompts: {
          orderBy: { createdAt: "asc" },
          include: {
            responses: {
              orderBy: { createdAt: "asc" },
              include: { extracted: true },
            },
          },
        },
      },
    });

    if (!job) {
      return NextResponse.json(
        { error: "Not found" },
        {
          status: 404,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    const rawShare =
      (job.metrics?.competitorShare as Record<string, number> | null) || null;
    let positiveSentimentRate: number | null = null;
    let competitorShare: Record<string, number> | null = null;
    if (rawShare) {
      const { __positiveSentimentRate, ...rest } = rawShare as Record<
        string,
        number
      > & { __positiveSentimentRate?: number };
      positiveSentimentRate =
        typeof __positiveSentimentRate === "number"
          ? Math.round(__positiveSentimentRate * 10000) / 100
          : null;
      competitorShare = rest;
    }

    const metrics = job.metrics
      ? {
          ...job.metrics,
          competitorShare: competitorShare ?? job.metrics.competitorShare,
          positiveSentimentRate,
        }
      : null;

    return NextResponse.json(
      {
        id: job.id,
        companyName: job.companyName,
        website: job.website,
        description: job.description,
        competitors: job.competitors,
        status: job.status,
        progress: job.progress,
        progressMessage: job.progressMessage,
        error: job.error,
        warnings: job.warnings,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        metrics,
        recommendation: job.recommendation,
        prompts: job.prompts.map((p) => ({
          id: p.id,
          category: p.category,
          prompt: p.prompt,
          responses: p.responses.map((r) => ({
            id: r.id,
            provider: r.provider,
            model: r.model,
            rawResponse: r.rawResponse,
            latencyMs: r.latencyMs,
            error: r.error,
            extracted: r.extracted,
          })),
        })),
      },
      {
        headers: {
          "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        },
      }
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[results]", error);
    return NextResponse.json({ error: "Failed to fetch results" }, { status: 500 });
  }
}
