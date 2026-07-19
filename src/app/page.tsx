import { AppHeader } from "@/components/AppHeader";
import { AnalyzeForm } from "@/components/AnalyzeForm";
import { getOptionalUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export default async function HomePage() {
  const user = await getOptionalUser();
  const company = user
    ? await prisma.company.findUnique({ where: { userId: user.id } })
    : null;

  return (
    <>
      <AppHeader user={user} />
      <main className="flex flex-1 flex-col px-4 py-12">
        <div className="mx-auto mb-10 max-w-xl text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-stone-900">
            Analyze AI visibility
          </h1>
          <p className="mt-2 text-stone-600">
            Enter your company details. We&apos;ll query multiple AI assistants and
            score how often you&apos;re recommended.
          </p>
        </div>
        <AnalyzeForm
          company={
            company
              ? {
                  name: company.name,
                  website: company.website,
                  description: company.description,
                  competitors: company.competitors,
                }
              : null
          }
        />
      </main>
    </>
  );
}
