// 服务端调用后端 API。后端按 Host 头确定租户，所以要把浏览器访问的主机名原样带过去；
// fetch 不允许改 Host 头，这里用 node:http。
import { request } from "node:http";
import { request as httpsRequest } from "node:https";

export interface ApiResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export function callApi(opts: {
  apiUrl: string;
  host: string;
  method: string;
  path: string;
  token?: string;
  body?: Buffer;
  contentType?: string;
  clientIp?: string;
  userAgent?: string;
}): Promise<ApiResponse> {
  const url = new URL(opts.path, opts.apiUrl);
  const send = url.protocol === "https:" ? httpsRequest : request;
  return new Promise((resolve, reject) => {
    const req = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: opts.method,
        headers: {
          host: opts.host,
          accept: "application/json",
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.contentType ? { "content-type": opts.contentType } : {}),
          ...(opts.clientIp ? { "x-forwarded-for": opts.clientIp } : {}),
          ...(opts.userAgent ? { "user-agent": opts.userAgent } : {}),
          ...(opts.body ? { "content-length": String(opts.body.length) } : {}),
        },
        timeout: 15_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("API request timed out")));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
