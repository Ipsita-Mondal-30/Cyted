"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

type CompanyPrefill = {
  name: string;
  website: string | null;
  description: string | null;
  competitors: string[] | unknown;
} | null;

export function AnalyzeForm({ company }: { company: CompanyPrefill }) {
  const router = useRouter();
  const competitorsList = Array.isArray(company?.competitors)
    ? (company!.competitors as string[])
    : [];

  const [companyName, setCompanyName] = useState(company?.name || "");
  const [website, setWebsite] = useState(company?.website || "");
  const [description, setDescription] = useState(company?.description || "");
  const [competitors, setCompetitors] = useState(competitorsList.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/analysis/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyName,
          website: website || null,
          description: description || null,
          competitors: competitors
            .split("\n")
            .map((c) => c.trim())
            .filter(Boolean),
        }),
      });

      const data = await res.json();
      if (res.status === 401) {
        router.push(`/login?next=${encodeURIComponent("/")}`);
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || "Failed to start analysis");
      }

      router.push(`/dashboard/${data.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto w-full max-w-xl space-y-5">
      <div>
        <label htmlFor="companyName" className="block text-sm font-medium text-stone-700">
          Company name <span className="text-red-600">*</span>
        </label>
        <input
          id="companyName"
          required
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-stone-900 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20"
          placeholder="Nike"
        />
      </div>

      <div>
        <label htmlFor="website" className="block text-sm font-medium text-stone-700">
          Website
        </label>
        <input
          id="website"
          type="url"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-stone-900 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20"
          placeholder="https://nike.com"
        />
      </div>

      <div>
        <label htmlFor="description" className="block text-sm font-medium text-stone-700">
          Description
        </label>
        <textarea
          id="description"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-stone-900 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20"
          placeholder="Leading athletic footwear and apparel company."
        />
      </div>

      <div>
        <label htmlFor="competitors" className="block text-sm font-medium text-stone-700">
          Competitors{" "}
          <span className="font-normal text-stone-500">
            (optional, one per line — we typo-correct names and auto-add top 5 more)
          </span>
        </label>
        <textarea
          id="competitors"
          rows={4}
          value={competitors}
          onChange={(e) => setCompetitors(e.target.value)}
          className="mt-1.5 w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-stone-900 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20"
          placeholder={"Adidas\nPuma\nNew Balance"}
        />
        <p className="mt-1.5 text-xs text-stone-500">
          Brand names are corrected automatically. We also discover five additional
          competitors and dedupe against your brand and inputs.
        </p>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-emerald-700 px-4 py-3 text-sm font-medium text-white transition hover:bg-emerald-800 disabled:opacity-60"
      >
        {loading ? "Starting analysis…" : "Analyze"}
      </button>
    </form>
  );
}
