"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getManager, safeReturnPath } from "@/lib/auth";

export default function Callback() {
  const router = useRouter();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    getManager()
      .signinRedirectCallback()
      .then((user) => {
        const state = user.state as { returnTo?: unknown } | undefined;
        router.replace(safeReturnPath(state?.returnTo));
      })
      .catch(() => setError("Sign-in did not complete. Please try again."));
  }, [router]);

  return error ? (
    <div className="p-8 text-sm">
      <p role="alert" className="mb-3 text-red-700">
        {error}
      </p>
      <Link className="text-indigo-700 underline" href="/">
        Start again
      </Link>
    </div>
  ) : (
    <p className="p-8 text-sm text-slate-500">Signing in…</p>
  );
}
