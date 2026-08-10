import { AppHeader } from "@/components/AppHeader";
import { AnalysisDashboard } from "@/components/AnalysisDashboard";
import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";

export default async function PublicReportPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;

  const job = await prisma.analysisJob.findFirst({
    where: { id: jobId, status: "COMPLETED" },
    select: { id: true, companyName: true },
  });

  if (!job) notFound();

  return (
    <>
      <AppHeader user={null} />
      <AnalysisDashboard jobId={jobId} mode="public" />
    </>
  );
}
