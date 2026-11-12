"use client";

// 浏览器调后端：走 /bff/*（令牌在服务端会话里）。写操作带自定义头，服务端据此拒绝跨站表单提交。
export class BffError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function bff<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const res = await fetch(`/bff/${path.replace(/^\/+/, "")}`, {
    method,
    credentials: "same-origin",
    headers: { accept: "application/json", ...(method !== "GET" ? { "x-requested-with": "staredu" } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401) {
    const platform = window.location.hostname.split(".")[0] === "platform";
    window.location.assign(`${platform ? "" : "/admin"}/auth/login?return=${encodeURIComponent(window.location.pathname)}`);
    throw new BffError("Not signed in", 401);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new BffError(typeof data?.message === "string" ? data.message : `Request failed (${res.status})`, res.status);
  return data as T;
}
