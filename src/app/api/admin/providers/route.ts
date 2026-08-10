import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import type { ProviderName } from "@/lib/providers/types";
import {
  DEFAULT_PROVIDER_FLAGS,
  getProviderFlags,
  setProviderFlags,
  type ProviderFlags,
} from "@/lib/services/provider-settings.service";

export const dynamic = "force-dynamic";

const ALL: ProviderName[] = ["openai", "gemini", "claude", "groq"];

function keyPresent(name: ProviderName): boolean {
  const c = getConfig();
  switch (name) {
    case "openai":
      return Boolean(c.openaiApiKey);
    case "gemini":
      return Boolean(c.geminiApiKey);
    case "claude":
      return Boolean(c.anthropicApiKey);
    case "groq":
      return Boolean(c.groqApiKey);
  }
}

function modelFor(name: ProviderName): string {
  const c = getConfig();
  switch (name) {
    case "openai":
      return c.openaiModel;
    case "gemini":
      return c.geminiModel;
    case "claude":
      return c.claudeModel;
    case "groq":
      return c.groqModel;
  }
}

export async function GET() {
  const flags = await getProviderFlags();
  return NextResponse.json({
    providers: ALL.map((name) => ({
      name,
      label:
        name === "openai"
          ? "ChatGPT / OpenAI"
          : name === "claude"
            ? "Claude"
            : name === "groq"
              ? "Groq"
              : "Gemini",
      model: modelFor(name),
      keyPresent: keyPresent(name),
      enabled: flags[name] !== false,
      active: keyPresent(name) && flags[name] !== false,
    })),
  });
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    enabledProviders?: Partial<ProviderFlags>;
  };

  const patch: Partial<ProviderFlags> = {};
  for (const name of ALL) {
    if (typeof body.enabledProviders?.[name] === "boolean") {
      patch[name] = body.enabledProviders[name];
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "Provide enabledProviders with boolean flags" },
      { status: 400 }
    );
  }

  const flags = await setProviderFlags(patch);
  return NextResponse.json({
    ok: true,
    enabledProviders: { ...DEFAULT_PROVIDER_FLAGS, ...flags },
  });
}
