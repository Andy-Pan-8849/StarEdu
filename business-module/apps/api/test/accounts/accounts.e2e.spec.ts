// 账号：创建顺序（业务库 → Keycloak）、重复、邮箱同步、Keycloak 失败后的对账与修复。
import { Harness } from "../helpers/app";

const MAILPIT = process.env.MAILPIT_API_URL ?? "http://localhost:8125";

async function mailTo(address: string): Promise<boolean> {
  for (let i = 0; i < 12; i += 1) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()) as { messages: Array<{ To: Array<{ Address: string }> }> };
    if (list.messages.some((m) => m.To.some((t) => t.Address === address))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

describe("accounts and Keycloak reconciliation", () => {
  const h = new Harness();
  let bossToken: string;
  const admin = () => h.call(bossToken);
  const kcUser = (username: string) => h.keycloak.findUser(h.realm, username);

  beforeAll(async () => {
    await h.start();
    bossToken = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
  });
  afterAll(() => h.stop());

  it("creates the business record, then the Keycloak user (with the account id attribute), then sends the invite", async () => {
    const res = await admin().post("/api/accounts", { username: "new.hire", email: "new.hire@example.test" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: "new.hire", status: "pending", inviteSent: true });
    const kc = await h.keycloak.getUser(h.realm, res.body.keycloakUserId);
    expect(kc).toMatchObject({ username: "new.hire", email: "new.hire@example.test", enabled: true });
    expect(kc?.attributes?.account_id).toEqual([res.body.id]);
    expect(await mailTo("new.hire@example.test")).toBe(true);
    const row = await h.owner.account.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ keycloakUserId: res.body.keycloakUserId, status: "pending", createdBy: expect.any(String) });
  });

  it("rejects duplicates and bad input", async () => {
    expect((await admin().post("/api/accounts", { username: "new.hire" })).status).toBe(409);
    expect((await admin().post("/api/accounts", { username: "other.name", email: "new.hire@example.test" })).status).toBe(409);
    expect((await admin().post("/api/accounts", { username: "Bad Name" })).status).toBe(400);
    expect((await admin().post("/api/accounts", { username: "ok.name", email: "not-an-email" })).status).toBe(400);
    expect((await admin().post("/api/accounts", { username: "ok.name", roleIds: ["11111111-1111-4111-8111-111111111111"] })).status).toBe(400);
    const person = await h.owner.person.create({ data: { tenantId: h.tenant.tenantId, type: "staff", fullName: "Taken" } });
    expect((await admin().post("/api/accounts", { username: "linked.one", personId: person.id })).status).toBe(201);
    expect((await admin().post("/api/accounts", { username: "linked.two", personId: person.id })).status).toBe(409); // 一个人只有一个账号
  });

  it("changing the email is pushed to Keycloak", async () => {
    const created = (await admin().post("/api/accounts", { username: "mail.change", email: "before@example.test", sendInvite: false })).body;
    const res = await admin().patch(`/api/accounts/${created.id}/email`, { email: "after@example.test" });
    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(true);
    expect((await h.keycloak.getUser(h.realm, created.keycloakUserId))?.email).toBe("after@example.test");
    expect((await admin().patch(`/api/accounts/${created.id}/email`, { email: "new.hire@example.test" })).status).toBe(409);
  });

  it("if Keycloak creation fails the record stays pending; reconcile reports it and fix repairs it", async () => {
    // 让 Keycloak 里已经有同名用户（比如有人手工建过），创建就会失败
    const stray = await h.keycloak.createUser(h.realm, { username: "zed", email: "zed@example.test", accountId: "not-an-account" });
    const res = await admin().post("/api/accounts", { username: "zed", email: "zed@example.test", sendInvite: false });
    expect(res.status).toBe(502);
    const row = await h.owner.account.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, username: "zed" } });
    expect(row).toMatchObject({ status: "pending", keycloakUserId: null });

    const report = (await admin().post("/api/accounts/reconcile", {})).body;
    expect(report.discrepancies).toEqual(
      expect.arrayContaining([
        { type: "missing_in_keycloak", accountId: row.id, username: "zed" },
        { type: "unlinked_in_keycloak", keycloakUserId: stray, username: "zed" },
      ]),
    );
    expect(report.fixed).toBe(0); // 只报告，不修
    expect((await h.owner.account.findUniqueOrThrow({ where: { id: row.id } })).keycloakUserId).toBeNull();

    const fixed = (await admin().post("/api/accounts/reconcile", { fix: true })).body;
    expect(fixed.fixed).toBeGreaterThan(0);
    expect((await h.owner.account.findUniqueOrThrow({ where: { id: row.id } })).keycloakUserId).toBe(stray); // 接上了已有的同名用户
    const after = (await admin().post("/api/accounts/reconcile", {})).body;
    expect(after.discrepancies.filter((d: { username: string }) => d.username === "zed")).toEqual([]);
  });

  it("reconcile finds enabled/email mismatches and fixes them towards the business database", async () => {
    const created = (await admin().post("/api/accounts", { username: "drift", email: "drift@example.test", sendInvite: false })).body;
    await h.owner.account.update({ where: { id: created.id }, data: { status: "disabled", email: "drift2@example.test" } }); // 绕过接口，制造不一致
    const report = (await admin().post("/api/accounts/reconcile", {})).body;
    const mine = report.discrepancies.filter((d: { accountId?: string }) => d.accountId === created.id);
    expect(mine.map((d: { type: string }) => d.type).sort()).toEqual(["email_mismatch", "enabled_mismatch"]);
    await admin().post("/api/accounts/reconcile", { fix: true });
    const kc = await h.keycloak.getUser(h.realm, created.keycloakUserId);
    expect(kc).toMatchObject({ enabled: false, email: "drift2@example.test" });
    const clean = (await admin().post("/api/accounts/reconcile", {})).body;
    expect(clean.discrepancies.filter((d: { accountId?: string }) => d.accountId === created.id)).toEqual([]);
  });

  it("a Keycloak user with no business account is reported but never deleted", async () => {
    const id = await h.keycloak.createUser(h.realm, { username: "ghost", accountId: "nobody" });
    const report = (await admin().post("/api/accounts/reconcile", { fix: true })).body;
    expect(report.discrepancies).toEqual(expect.arrayContaining([{ type: "unlinked_in_keycloak", keycloakUserId: id, username: "ghost" }]));
    expect(await kcUser("ghost")).not.toBeNull();
  });

  it("creating, changing and reconciling are audited; without the permission they are refused", async () => {
    const logs = (await admin().get("/api/audit-logs?size=100")).body as Array<{ action: string }>;
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(["account.create", "account.email", "account.reconcile"]));
    const plain = await h.user("plain", { person: "staff" });
    const token = await plain.token();
    expect((await h.call(token).post("/api/accounts", { username: "x.y" })).status).toBe(403);
    expect((await h.call(token).post("/api/accounts/reconcile", {})).status).toBe(403);
    expect((await h.call(token).get("/api/accounts")).status).toBe(403);
  });
});
