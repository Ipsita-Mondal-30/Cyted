import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { serializeAnalysisReport } from "@/lib/report-serialize";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Public, unauthenticated report payload for completed analyses.
 * Used by shareable /report/[jobId] links.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await context.params;

    const job = await prisma.analysisJob.findFirst({
      where: { id: jobId, status: "COMPLETED" },
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
        { error: "Report not found" },
        {
          status: 404,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    return NextResponse.json(serializeAnalysisReport(job), {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (error) {
    console.error("[public-report]", error);
    return NextResponse.json(
      { error: "Failed to fetch report" },
      { status: 500 }
    );
  }
}
