import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET() {
  try {
    const user = await requireUser();
    const company = await prisma.company.findUnique({
      where: { userId: user.id },
    });

    if (!company) {
      return NextResponse.json(null);
    }

    return NextResponse.json({
      id: company.id,
      name: company.name,
      website: company.website,
      description: company.description,
      competitors: company.competitors,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to fetch company" }, { status: 500 });
  }
}
