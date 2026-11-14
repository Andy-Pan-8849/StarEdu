// 实时推送（WebSocket）。
//   连接：浏览器先用会话请求 `POST /notifications/ws-ticket` 拿一次性票据（Redis 里 30 秒有效，取一次就删），
//         再连 `ws://<租户域名>:<API 端口>/ws?ticket=…`。票据里是租户和账号；连接的主机名和 Origin 都必须属于同一个租户。
//   多实例：新消息写入后发布到 Redis 频道 `notify`；每个 API 实例都订阅，把消息推给自己手里的那些连接。
//   断线：推送只说"有新消息"（带消息 id），内容用消息接口取；重连后用 `?after=` 补拉错过的。
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type Redis from "ioredis";
import { WebSocket, WebSocketServer } from "ws";
import { PlatformPrismaService } from "../platform/platform-prisma.service";
import { RedisService } from "../redis/redis.service";
import { tenantCodeFromHost } from "../tenancy/request-scope";

export const WS_PATH = "/ws";
export const TICKET_TTL_SECONDS = 30;

@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(RealtimeService.name);
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private subscriber: Redis | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private onUpgrade: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null;
  private server: { off: (e: string, f: never) => void } | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly db: PlatformPrismaService,
    private readonly adapter: HttpAdapterHost,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const server = this.adapter.httpAdapter?.getHttpServer();
    if (server) {
      this.onUpgrade = (req, socket, head) => void this.upgrade(req, socket, head);
      server.on("upgrade", this.onUpgrade);
      this.server = server;
    }
    try {
      this.subscriber = this.redis.client.duplicate();
      this.subscriber.on("error", () => undefined);
      await this.subscriber.subscribe("notify");
      this.subscriber.on("message", (_channel, message) => this.fanOut(message));
    } catch (err) {
      this.log.warn(`realtime fan-out unavailable: ${err instanceof Error ? err.message : err}`);
    }
    this.heartbeat = setInterval(() => {
      for (const set of this.sockets.values()) for (const ws of set) ws.ping();
    }, 30_000);
    this.heartbeat.unref();
  }

  onModuleDestroy(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.server && this.onUpgrade) this.server.off("upgrade", this.onUpgrade as never);
    this.subscriber?.disconnect();
    for (const set of this.sockets.values()) for (const ws of set) ws.terminate();
    this.wss.close();
  }

  /** 这个实例上有多少条某账号的连接（测试用）。 */
  connections(tenantId: string, accountId: string): number {
    return this.sockets.get(`${tenantId}:${accountId}`)?.size ?? 0;
  }

  private fanOut(message: string): void {
    try {
      const m = JSON.parse(message) as { tenantId: string; accountId: string; id: string };
      for (const ws of this.sockets.get(`${m.tenantId}:${m.accountId}`) ?? []) ws.send(JSON.stringify({ event: "notification", id: m.id }));
    } catch {
      // 不是我们的格式：忽略
    }
  }

  private reject(socket: Duplex, status: string): void {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== WS_PATH) return this.reject(socket, "404 Not Found");
      const ticket = url.searchParams.get("ticket");
      if (!ticket || !/^[a-f0-9]{48}$/.test(ticket)) return this.reject(socket, "401 Unauthorized");
      const raw = await this.redis.client.getdel(`ws:ticket:${ticket}`); // 只能用一次
      if (!raw) return this.reject(socket, "401 Unauthorized");
      const { tenantId, accountId } = JSON.parse(raw) as { tenantId: string; accountId: string };
      // 连接的主机名必须属于票据里的租户；浏览器带 Origin 的话，它的主机名也必须是同一个租户
      const code = tenantCodeFromHost(req.headers.host);
      const tenant = code ? await this.db.tenant.findUnique({ where: { code } }) : null;
      if (!tenant || tenant.id !== tenantId) return this.reject(socket, "403 Forbidden");
      const origin = req.headers.origin;
      if (origin && tenantCodeFromHost(new URL(origin).host) !== code) return this.reject(socket, "403 Forbidden");
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const key = `${tenantId}:${accountId}`;
        if (!this.sockets.has(key)) this.sockets.set(key, new Set());
        this.sockets.get(key)!.add(ws);
        ws.on("close", () => {
          this.sockets.get(key)?.delete(ws);
          if (!this.sockets.get(key)?.size) this.sockets.delete(key);
        });
        ws.on("error", () => ws.terminate());
        ws.send(JSON.stringify({ event: "ready" }));
      });
    } catch {
      this.reject(socket, "400 Bad Request");
    }
  }
}
