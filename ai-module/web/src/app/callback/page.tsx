"use client";

/**
 * 文件：app/callback/page.tsx
 * 作用：登录回调页（路径 /callback）。Keycloak 登录成功后浏览器被带回这里，
 * 这里完成 OIDC 授权码换令牌，然后跳回登录前所在的页面（路径经 safeReturnPath 检查，只允许站内）
 *   。
 * useRef 保证在 React 严格模式下只处理一次回调（授权码只能用一次）。
 */

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
