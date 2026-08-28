import { redirect } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { getOptionalUser } from "@/lib/auth";
import { LoginButton } from "./LoginButton";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getOptionalUser();
  if (user) redirect("/");

  const { error } = await searchParams;

  return (
    <div className="flex min-h-screen flex-col bg-black text-white">
      <AppHeader user={null} />
      {error === "auth" ? (
        <p className="mx-auto mt-6 max-w-md rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-center text-sm text-red-200">
          Sign-in failed. Please try again.
        </p>
      ) : null}
      <LoginButton />
    </div>
  );
}
