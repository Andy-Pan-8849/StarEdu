import { config } from "@/lib/config";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type TokenSource = {
  getToken: () => Promise<string | null>;
  onUnauthorized: () => void;
};

type Options = { method?: string; json?: unknown; form?: FormData; raw?: boolean; accept?: string };

/** Calls the API as the signed-in user. A 401 means the token is no longer good: sign in again. */
export function createApi(source: TokenSource) {
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

  async function json<T>(path: string, options: Options = {}): Promise<T> {
    const response = await call(path, options);
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  async function blob(path: string): Promise<Blob> {
    return (await call(path)).blob();
  }

  /** POST and read the reply as server-sent events (see lib/sse.ts). */
  async function stream(path: string, payload: unknown): Promise<Response> {
    return call(path, { method: "POST", json: payload, accept: "text/event-stream" });
  }

  return { json, blob, stream };
}

export type Api = ReturnType<typeof createApi>;

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
