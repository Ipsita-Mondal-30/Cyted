import { AppHeader } from "@/components/AppHeader";
import { AnalysisDashboard } from "@/components/AnalysisDashboard";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";

export default async function JobDashboardPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const user = await requireUser();
  const { jobId } = await params;

  const job = await prisma.analysisJob.findFirst({
    where: { id: jobId, userId: user.id },
    select: { id: true },
  });

  if (!job) notFound();

  return (
    <>
      <AppHeader user={user} />
      <AnalysisDashboard jobId={jobId} />
    </>
  );
}
