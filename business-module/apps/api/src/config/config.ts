import { z } from "zod";

// 环境变量集中在这里校验：缺了或格式不对，启动时就报错，而不是运行到一半才出问题。
const schema = z.object({
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  KEYCLOAK_URL: z.string().default("http://localhost:8180"),
  /** 平台入口专用的数据库连接（库所有者账号，绕过行级安全；只有平台域的请求会用到）。默认取迁移账号的连接串 */
  PLATFORM_DATABASE_URL: z.string().optional(),
  MIGRATION_DATABASE_URL: z.string().optional(),
  GRAFANA_URL: z.string().optional(),
  /** 是否提供 Swagger 文档页（/api-docs） */
  SWAGGER_ENABLED: z.string().optional(),
  /** 令牌里 iss 的前缀；Keycloak 按请求地址生成 iss，容器内外地址不同时才需要单独设置 */
  KEYCLOAK_ISSUER_BASE: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${problems}`);
  }
  return parsed.data;
}
