import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> }
) {
  try {
    const user = await requireUser();
    const { jobId } = await context.params;

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
      },
    });

    if (!job) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(job);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to fetch status" }, { status: 500 });
  }
}
