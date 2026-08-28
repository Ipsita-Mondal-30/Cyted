import { AppHeader } from "@/components/AppHeader";
import { AnalyzeForm } from "@/components/AnalyzeForm";
import { BrandLogoCarousel } from "@/components/BrandLogoCarousel";
import { getOptionalUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export default async function HomePage() {
  const user = await getOptionalUser();
  const company = user
    ? await prisma.company.findUnique({ where: { userId: user.id } })
    : null;

  return (
    <div className="min-h-full bg-black text-white">
      <AppHeader user={user} />
      <main>
        <section className="px-4 pb-6 pt-16 text-center sm:pt-20">
          <h1 className="mx-auto max-w-3xl font-sans text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            Optimize {company?.name || "your brand"}&apos;s AI Visibility today
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-zinc-400 sm:text-lg">
            Choose the prompts and topics that matter most, track your mentions
            over time, and take actions to boost your visibility.
          </p>
          <a
            href={user ? "#analyze" : "/login"}
            className="mt-8 inline-flex rounded-full bg-white px-6 py-3 text-sm font-semibold text-black transition hover:bg-zinc-200"
          >
            {user ? "New analysis" : "Log in to start"}
          </a>
          <BrandLogoCarousel />
        </section>

        <section
          id="analyze"
          className="border-t border-zinc-900 px-4 py-16"
        >
          <div className="mx-auto mb-8 max-w-xl text-center">
            <h2 className="font-sans text-2xl font-semibold tracking-tight text-white">
              Start an analysis
            </h2>
            <p className="mt-2 text-sm text-zinc-400">
              We query ChatGPT, Gemini, Claude, and Groq with live web search,
              then score how often your brand is mentioned and recommended.
            </p>
          </div>
          {user ? (
            <div className="mx-auto max-w-xl [&_label]:text-zinc-300 [&_input]:border-zinc-700 [&_input]:bg-zinc-950 [&_input]:text-white [&_textarea]:border-zinc-700 [&_textarea]:bg-zinc-950 [&_textarea]:text-white [&_p]:text-zinc-500 [&_span]:text-zinc-500">
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
            </div>
          ) : (
            <div className="mx-auto max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 px-6 py-8 text-center">
              <p className="text-sm text-zinc-400">
                Sign in to run analyses and view your history.
              </p>
              <a
                href="/login?next=/"
                className="mt-5 inline-flex rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black hover:bg-zinc-200"
              >
                Log in with Google
              </a>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
