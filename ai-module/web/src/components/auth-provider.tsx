"use client";

/**
 * 文件：components/auth-provider.tsx
 * 作用：登录状态的提供者（React Context）。包住的组件可以用 useAuth() 取到：登录状态、API
 *   客户端、退出和重试。
 * 流程：挂载时看本地有没有登录用户——没有就跳去 Keycloak 登录；有就调 /me 取身份。
 * 状态机：loading -> ready(带 me) 或 error(带提示，可重试)。
 * API 客户端的令牌来源：取当前用户的 access_token，过期了先静默续期；续期失败视为未登录。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createApi, userMessage, type Api } from "@/lib/api";
import { getManager } from "@/lib/auth";
import type { Me } from "@/lib/types";

/**
 * 登录状态：加载中 / 出错（带提示） / 就绪（带当前用户）。
 */
type AuthState =
  { status: "loading" } | { status: "error"; message: string } | { status: "ready"; me: Me };

type AuthContextValue = { state: AuthState; api: Api; signOut: () => void; retry: () => void };

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * 取登录上下文；必须在 AuthProvider 内使用。
 */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth needs an AuthProvider");
  return value;
}

/**
 * 取当前用户；只能在已登录（ready）时使用，否则抛错。
 */
export function useMe(): Me {
  const { state } = useAuth();
  if (state.status !== "ready") throw new Error("useMe needs a signed-in user");
  return state.me;
}

/**
 * 跳去登录，并记住当前所在路径，登录后回到这里。
 */
function signIn(): void {
  const returnTo = window.location.pathname + window.location.search;
  void getManager().signinRedirect({ state: { returnTo } });
}

/**
 * 提供登录上下文，并在挂载时完成“检查登录 -> 取 /me”。
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // API 客户端只创建一次；令牌来源：当前用户的令牌，过期则静默续期
  const api = useMemo(
    () =>
      createApi({
        getToken: async () => {
          const manager = getManager();
          let user = await manager.getUser();
          if (user?.expired) {
            try {
              user = await manager.signinSilent();
            } catch {
              user = null;
            }
          }
          return user?.access_token ?? null;
        },
        onUnauthorized: signIn,
      }),
    [],
  );

  useEffect(() => {
    // cancelled：组件卸载后不再更新状态（避免对已卸载组件 setState）
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      const user = await getManager().getUser();
      if (!user) {
        signIn();
        return;
      }
      try {
        const me = await api.json<Me>("/me");
        if (!cancelled) setState({ status: "ready", me });
      } catch (error) {
        if (!cancelled) setState({ status: "error", message: userMessage(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, attempt]);

  const signOut = useCallback(() => {
    void getManager().signoutRedirect();
  }, []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return (
    <AuthContext.Provider value={{ state, api, signOut, retry }}>{children}</AuthContext.Provider>
  );
}
