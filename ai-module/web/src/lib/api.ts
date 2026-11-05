/**
 * 文件：lib/api.ts
 * 作用：前端调用后端 API 的封装。
 * 主要思想：
 *   - 每次请求都自动带上当前登录用户的令牌（Authorization: Bearer）；没有令牌或服务端返回 401，
 *     说明登录失效，调用 onUnauthorized 让用户重新登录。
 *   - 失败时把服务端统一格式的错误 {error:{code,message}} 解析成 ApiError 抛出。
 *   - 提供四种调用：json（JSON 收发）、blob（取文件）、stream（POST 后按 SSE 读事件流）。
 *   - userMessage 把错误转成对用户友好的提示（403 无权限、429 太频繁、5xx 服务问题）。
 */

import { config } from "@/lib/config";

/**
 * 后端返回的错误：HTTP 状态码、错误码和信息。
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 令牌来源：getToken 取当前令牌；onUnauthorized 在登录失效时被调用（通常是跳去登录）。
 */
export type TokenSource = {
  getToken: () => Promise<string | null>;
  onUnauthorized: () => void;
};

/**
 * 一次请求的选项：方法、JSON 体、表单体（上传文件）、raw、accept（要流式时设成
 *   text/event-stream）。
 */
type Options = { method?: string; json?: unknown; form?: FormData; raw?: boolean; accept?: string };

/**
 * 创建 API 客户端（登录用户的身份通过 TokenSource 提供）。401 表示令牌不再有效，需要重新登录。
 */
export function createApi(source: TokenSource) {
  /**
   * 底层请求：带令牌、发请求、处理 401 和错误响应，返回原始 Response。
   */
  async function call(path: string, options: Options = {}): Promise<Response> {
    const token = await source.getToken();
    if (!token) {
      source.onUnauthorized();
      throw new ApiError(401, "unauthenticated", "Not signed in");
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (options.accept) headers.Accept = options.accept;
    let body: BodyInit | undefined;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.form) {
      body = options.form;
    }
    const response = await fetch(`${config.apiUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
    });
    if (response.status === 401) {
      source.onUnauthorized();
    }
    if (!response.ok) {
      let code = "internal_error";
      let message = response.statusText;
      try {
        const payload = (await response.json()) as { error?: { code?: string; message?: string } };
        code = payload.error?.code ?? code;
        message = payload.error?.message ?? message;
      } catch {
        // not JSON: keep the status text
      }
      throw new ApiError(response.status, code, message);
    }
    return response;
  }

  /**
   * 请求并把结果当 JSON 解析；204（无内容）返回 undefined。
   */
  async function json<T>(path: string, options: Options = {}): Promise<T> {
    const response = await call(path, options);
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  /**
   * 请求并取二进制内容（如原文件）。
   */
  async function blob(path: string): Promise<Blob> {
    return (await call(path)).blob();
  }

  /** POST and read the reply as server-sent events (see lib/sse.ts). */
  async function stream(path: string, payload: unknown): Promise<Response> {
    return call(path, { method: "POST", json: payload, accept: "text/event-stream" });
  }

  return { json, blob, stream };
}

/**
 * createApi 返回对象的类型，组件通过它拿到客户端。
 */
export type Api = ReturnType<typeof createApi>;

/**
 * 把错误转成给用户看的提示文字（不暴露技术细节）。
 */
export function userMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "You do not have permission to do that.";
    if (error.status === 429) return "Too many requests. Please wait a minute.";
    if (error.status === 409) return error.message;
    if (error.status === 422)
      return error.message === "Request validation failed"
        ? "Please check the fields and try again."
        : error.message;
    if (error.status >= 500) return "The service had a problem. Please try again.";
    return error.message;
  }
  return "Could not reach the service. Please try again.";
}
