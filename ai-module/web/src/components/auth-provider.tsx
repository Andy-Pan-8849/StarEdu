"use client";

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

type AuthState =
  { status: "loading" } | { status: "error"; message: string } | { status: "ready"; me: Me };

type AuthContextValue = { state: AuthState; api: Api; signOut: () => void; retry: () => void };

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth needs an AuthProvider");
  return value;
}

export function useMe(): Me {
  const { state } = useAuth();
  if (state.status !== "ready") throw new Error("useMe needs a signed-in user");
  return state.me;
}

function signIn(): void {
  const returnTo = window.location.pathname + window.location.search;
  void getManager().signinRedirect({ state: { returnTo } });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

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
