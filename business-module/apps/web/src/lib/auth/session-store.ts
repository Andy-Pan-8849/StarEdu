// 登录会话存在服务端（Redis），浏览器只拿一个不透明的会话 id（httpOnly cookie）。
// 令牌永远不进浏览器：不会被页面脚本读到，也不受 cookie 大小限制。
import Redis from "ioredis";
import { randomToken } from "./pkce";

export interface WebSession {
  tenantCode: string;
  entry: "admin" | "portal" | "platform";
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** 访问令牌过期时间（毫秒时间戳） */
  accessExpiresAt: number;
  /** 刷新令牌过期时间（毫秒时间戳） */
  refreshExpiresAt: number;
}

export interface SessionStore {
  create(session: WebSession): Promise<string>;
  get(id: string): Promise<WebSession | null>;
  update(id: string, session: WebSession): Promise<void>;
  delete(id: string): Promise<void>;
}

const key = (id: string) => `web:session:${id}`;

export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: Redis) {}

  private ttl(session: WebSession): number {
    return Math.max(60, Math.min(Math.floor((session.refreshExpiresAt - Date.now()) / 1000), 12 * 3600));
  }
  async create(session: WebSession): Promise<string> {
    const id = randomToken(32);
    await this.redis.set(key(id), JSON.stringify(session), "EX", this.ttl(session));
    return id;
  }
  async get(id: string): Promise<WebSession | null> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(id)) return null;
    const raw = await this.redis.get(key(id));
    return raw ? (JSON.parse(raw) as WebSession) : null;
  }
  async update(id: string, session: WebSession): Promise<void> {
    await this.redis.set(key(id), JSON.stringify(session), "EX", this.ttl(session));
  }
  async delete(id: string): Promise<void> {
    await this.redis.del(key(id));
  }
}

let shared: RedisSessionStore | null = null;
export function sessionStore(redisUrl: string): SessionStore {
  shared ??= new RedisSessionStore(new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 }));
  return shared;
}
