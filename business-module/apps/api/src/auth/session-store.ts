// 登录会话在 Redis 里的两样东西：
//   - 拒绝名单：被强退的会话（按 sid），令牌即使没过期也拒绝；
//   - 在线用户：每个租户一组键 online:<租户id>:<sid>，租户之间用键前缀隔离。
// Redis 不可用时调用方应"拒绝"而不是"放行"。
import { Injectable } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";

export interface OnlineSession {
  sid: string;
  accountId: string;
  username: string;
  entry?: string;
  ip?: string;
  userAgent?: string;
  loginAt: string;
  lastSeen: string;
}

const ONLINE_TTL_SECONDS = 3600;
/** 强退后拒绝名单保留多久：要超过访问令牌寿命（15 分钟）。 */
const DENY_TTL_SECONDS = 1800;
const TOUCH_EVERY_MS = 30_000;

@Injectable()
export class SessionStore {
  private readonly touched = new Map<string, number>();

  constructor(private readonly redis: RedisService) {}

  private deniedKey(realm: string, sid: string): string {
    return `deny:sid:${realm}:${sid}`;
  }
  private onlineKey(tenantId: string, sid: string): string {
    return `online:${tenantId}:${sid}`;
  }

  async isDenied(realm: string, sid: string): Promise<boolean> {
    return (await this.redis.client.exists(this.deniedKey(realm, sid))) === 1;
  }

  async deny(realm: string, sid: string): Promise<void> {
    await this.redis.client.set(this.deniedKey(realm, sid), "1", "EX", DENY_TTL_SECONDS);
  }

  /** 记录/刷新在线状态；同一会话 30 秒内只写一次，减少 Redis 压力。force 用于登录登记。 */
  async touch(
    tenantId: string,
    session: { sid: string; accountId: string; username: string; entry?: string; ip?: string; userAgent?: string },
    force = false,
  ): Promise<void> {
    const key = this.onlineKey(tenantId, session.sid);
    const now = Date.now();
    if (!force && now - (this.touched.get(key) ?? 0) < TOUCH_EVERY_MS) return;
    this.touched.set(key, now);
    if (this.touched.size > 10_000) this.touched.clear();
    const fields: Record<string, string> = {
      accountId: session.accountId,
      username: session.username,
      lastSeen: new Date(now).toISOString(),
    };
    if (session.entry) fields.entry = session.entry;
    if (session.ip) fields.ip = session.ip;
    if (session.userAgent) fields.userAgent = session.userAgent;
    const pipeline = this.redis.client.multi();
    pipeline.hset(key, fields);
    pipeline.hsetnx(key, "loginAt", new Date(now).toISOString());
    pipeline.expire(key, ONLINE_TTL_SECONDS);
    await pipeline.exec();
  }

  async list(tenantId: string): Promise<OnlineSession[]> {
    const prefix = `online:${tenantId}:`;
    const out: OnlineSession[] = [];
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.client.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 200);
      cursor = next;
      for (const key of keys) {
        const row = await this.redis.client.hgetall(key);
        if (row.accountId) out.push({ sid: key.slice(prefix.length), ...row } as unknown as OnlineSession);
      }
    } while (cursor !== "0");
    return out.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  async get(tenantId: string, sid: string): Promise<OnlineSession | null> {
    const row = await this.redis.client.hgetall(this.onlineKey(tenantId, sid));
    return row.accountId ? ({ sid, ...row } as unknown as OnlineSession) : null;
  }

  async remove(tenantId: string, sid: string): Promise<void> {
    await this.redis.client.del(this.onlineKey(tenantId, sid));
    this.touched.delete(this.onlineKey(tenantId, sid));
  }
}
