// 数据库结构检查：每张业务表都有 tenant_id，都开了行级安全，应用账号权限受限。
import { appClient, ownerClient } from "./helpers/fixtures";

// 没有 tenant_id 的表：租户表本身、固定入口、迁移历史
// 平台表：只给平台专用连接用，应用账号 biz_app 没有任何权限（下面有测试）
const PLATFORM_TABLES = ["platform_account", "platform_role", "platform_account_role", "platform_role_menu", "platform_audit_log", "scheduled_job", "job_run"];
const NO_TENANT_COLUMN = new Set(["tenant", "entry", "_prisma_migrations", ...PLATFORM_TABLES]);

describe("schema invariants", () => {
  const owner = ownerClient();
  const app = appClient();
  afterAll(async () => {
    await owner.$disconnect();
    await app.$disconnect();
  });

  async function tables(): Promise<string[]> {
    const rows = await owner.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'biz' AND table_type = 'BASE TABLE'`;
    return rows.map((r) => r.table_name);
  }

  it("every business table has a tenant_id column", async () => {
    const withColumn = new Set(
      (
        await owner.$queryRaw<Array<{ table_name: string }>>`
          SELECT table_name FROM information_schema.columns WHERE table_schema = 'biz' AND column_name = 'tenant_id'`
      ).map((r) => r.table_name),
    );
    const missing = (await tables()).filter((t) => !NO_TENANT_COLUMN.has(t) && !withColumn.has(t));
    expect(missing).toEqual([]);
  });

  it("row-level security is enabled, with at least one policy, on every tenant table", async () => {
    const rls = await owner.$queryRaw<Array<{ relname: string; relrowsecurity: boolean }>>`
      SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'biz' AND c.relkind = 'r'`;
    const policies = await owner.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_policies WHERE schemaname = 'biz'`;
    const withPolicy = new Set(policies.map((p) => p.tablename));
    const unprotected = rls
      .filter((r) => r.relname !== "entry" && r.relname !== "_prisma_migrations" && !PLATFORM_TABLES.includes(r.relname))
      .filter((r) => !r.relrowsecurity || !withPolicy.has(r.relname))
      .map((r) => r.relname);
    expect(unprotected).toEqual([]);
  });

  it("the application role is neither superuser nor allowed to bypass row-level security", async () => {
    const [role] = await owner.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'biz_app'`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const [current] = await app.$queryRaw<Array<{ current_user: string }>>`SELECT current_user`;
    expect(current.current_user).toBe("biz_app");
  });

  it("the application role has no access at all to the platform tables", async () => {
    for (const table of PLATFORM_TABLES) {
      await expect(app.$queryRawUnsafe(`SELECT 1 FROM biz.${table} LIMIT 1`)).rejects.toThrow(/permission denied/);
    }
  });

  it("the application role cannot create tenants or touch the migration history", async () => {
    await expect(app.$executeRaw`INSERT INTO biz.tenant (code, name) VALUES ('nope', 'Nope')`).rejects.toThrow(/permission denied/);
    await expect(app.$queryRaw`SELECT * FROM biz._prisma_migrations`).rejects.toThrow(/permission denied/);
  });

  it("platform-provided rows are unique, and the department ancestors column has a GIN index", async () => {
    const idx = await owner.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'biz'`;
    const def = (name: string) => idx.find((i) => i.indexname === name)?.indexdef ?? "";
    expect(def("role_platform_code_key")).toContain("WHERE (tenant_id IS NULL)");
    expect(def("entry_menu_platform_key")).toContain("WHERE (tenant_id IS NULL)");
    expect(def("dept_ancestors_idx").toLowerCase()).toContain("using gin");
  });
});
