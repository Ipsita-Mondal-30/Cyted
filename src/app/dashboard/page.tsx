import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { BrandLogo } from "@/components/BrandLogo";
import { ScoreBar, VisibilityTrendChart } from "@/components/VisibilityTrendChart";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export default async function DashboardListPage() {
  const user = await requireUser();
  const jobs = await prisma.analysisJob.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    include: { metrics: { select: { visibilityScore: true } } },
    take: 50,
  });

  const trend = jobs
    .flatMap((j) =>
      j.metrics
        ? [{ id: j.id, label: j.companyName, date: j.createdAt, score: j.metrics.visibilityScore }]
        : []
    )
    .slice(0, 20)
    .reverse();

  return (
    <div className="min-h-screen bg-zinc-50 text-stone-900">
      <AppHeader user={user} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-stone-900">Your analyses</h1>
          <Link
            href="/"
            className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            New analysis
          </Link>
        </div>

        <VisibilityTrendChart points={trend} />

        {jobs.length === 0 ? (
          <p className="text-stone-600">
            No analyses yet.{" "}
            <Link href="/" className="text-emerald-700 underline">
              Run your first one
            </Link>
            .
          </p>
        ) : (
          <ul className="divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white">
            {jobs.map((job) => (
              <li key={job.id}>
                <Link
                  href={`/dashboard/${job.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-stone-50"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <BrandLogo
                      name={job.companyName}
                      website={job.website}
                      size={32}
                      className="border border-stone-200"
                    />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-stone-900">{job.companyName}</p>
                      <p className="text-xs text-stone-500">
                        {job.createdAt.toLocaleString()} · {job.status}
                      </p>
                    </div>
                  </div>
                  {job.metrics ? (
                    <ScoreBar score={job.metrics.visibilityScore} />
                  ) : (
                    <span className="text-right text-sm text-stone-600">
                      {job.progressMessage || "—"}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
