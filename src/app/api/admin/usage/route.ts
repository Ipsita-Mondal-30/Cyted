import { NextResponse } from "next/server";
import { loadAdminUsage } from "@/lib/admin-usage";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Public admin usage endpoint — no auth by design.
 * Aggregates AI provider usage + estimated costs across all accounts.
 */
export async function GET() {
  try {
    const data = await loadAdminUsage();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error) {
    console.error("[admin/usage]", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to load usage",
      },
      { status: 500 }
    );
  }
}
