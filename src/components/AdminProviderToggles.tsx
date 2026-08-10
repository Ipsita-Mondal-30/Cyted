"use client";

import { useEffect, useState } from "react";

type ProviderRow = {
  name: string;
  label: string;
  model: string;
  keyPresent: boolean;
  enabled: boolean;
  active: boolean;
};

export function AdminProviderToggles() {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/providers", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setProviders(data.providers || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggle(name: string, enabled: boolean) {
    setSaving(name);
    setError(null);
    try {
      const res = await fetch("/api/admin/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledProviders: { [name]: enabled } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(null);
    }
  }

  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold text-stone-900">
        Answer engines
      </h2>
      <p className="mt-1 text-sm text-stone-600">
        Enable or disable providers for future analyses. Keys still come from
        env vars on Vercel/Render — toggles only control whether a key is used.
      </p>

      {error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {loading ? (
        <p className="mt-4 text-sm text-stone-500">Loading…</p>
      ) : (
        <div className="mt-4 divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white">
          {providers.map((p) => (
            <div
              key={p.name}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div>
                <p className="font-medium text-stone-900">{p.label}</p>
                <p className="text-xs text-stone-500">
                  {p.model}
                  {!p.keyPresent && " · API key missing"}
                  {p.keyPresent && p.enabled && " · active for analysis"}
                  {p.keyPresent && !p.enabled && " · disabled"}
                </p>
              </div>
              <button
                type="button"
                disabled={!p.keyPresent || saving === p.name}
                onClick={() => toggle(p.name, !p.enabled)}
                className={`relative h-7 w-12 rounded-full transition ${
                  p.enabled && p.keyPresent
                    ? "bg-emerald-600"
                    : "bg-stone-300"
                } disabled:opacity-40`}
                aria-pressed={p.enabled}
                aria-label={`Toggle ${p.label}`}
              >
                <span
                  className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${
                    p.enabled && p.keyPresent ? "left-5" : "left-0.5"
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
