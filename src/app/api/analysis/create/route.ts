import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { enqueueAnalysis } from "@/queue/queue";

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
        progressMessage: "Queued",
      },
    });

    await enqueueAnalysis(analysis.id);

    return NextResponse.json({ jobId: analysis.id });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("[create analysis]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create analysis" },
      { status: 500 }
    );
  }
}
