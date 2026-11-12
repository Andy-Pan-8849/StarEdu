// 开通租户：可重复运行、失败可重试、保留字与代码不可改。
import { realmName } from "@staredu/shared";
import type { KeycloakAdmin } from "../src/keycloak/keycloak-admin";
import { ProvisioningService } from "../src/provisioning/provisioning.service";
import { connectKeycloak, ownerClient, provisionTestTenant, randomCode, removeTestTenant } from "./helpers/fixtures";

const MAILPIT = process.env.MAILPIT_API_URL ?? "http://localhost:8125";

async function mailTo(address: string): Promise<boolean> {
  for (let i = 0; i < 12; i += 1) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()) as { messages: Array<{ To: Array<{ Address: string }> }> };
    if (list.messages.some((m) => m.To.some((t) => t.Address === address))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

describe("tenant provisioning", () => {
  const owner = ownerClient();
  let keycloak: KeycloakAdmin;
  const codes: string[] = [];
  let templateId: string | undefined;
  let menuId: string | undefined;

  beforeAll(async () => {
    keycloak = await connectKeycloak();
    templateId = (await owner.role.create({ data: { tenantId: null, code: `tpl-${randomCode()}`, name: "Template", isTemplate: true } })).id;
    menuId = (await owner.menu.create({ data: { tenantId: null, name: "Test menu", type: "directory" } })).id;
  });
  afterAll(async () => {
    for (const code of codes) await removeTestTenant(owner, keycloak, code);
    // 平台提供的测试行也要清掉，否则会混进别的测试开通的租户
    if (menuId) await owner.$executeRaw`DELETE FROM biz.menu WHERE id = ${menuId}::uuid`;
    if (templateId) await owner.$executeRaw`DELETE FROM biz.role WHERE template_id = ${templateId}::uuid`;
    if (templateId) await owner.$executeRaw`DELETE FROM biz.role WHERE id = ${templateId}::uuid`;
    await owner.$disconnect();
  });

  it("builds everything a new tenant needs", async () => {
    const t = await provisionTestTenant(owner, keycloak);
    codes.push(t.code);
    expect(t.created).toBe(true);
    const tenant = await owner.tenant.findUniqueOrThrow({ where: { id: t.tenantId } });
    expect(tenant.status).toBe("active");
    expect(tenant.provisionStep).toBe("done");
    expect(await keycloak.realmExists(realmName("tenant", t.code))).toBe(true);

    const campuses = await owner.campus.findMany({ where: { tenantId: t.tenantId } });
    expect(campuses).toHaveLength(1);
    expect(campuses[0]).toMatchObject({ type: "hq", code: "HQ", status: "normal" });
    const dept = await owner.dept.findUniqueOrThrow({ where: { id: campuses[0].deptId } });
    expect(dept.parentId).toBeNull();
    expect(dept.ancestors).toEqual([dept.id]);

    const roles = await owner.role.findMany({ where: { tenantId: t.tenantId } });
    expect(roles.map((r) => r.kind).sort()).toEqual(expect.arrayContaining(["student", "tenant_admin"]));
    const copy = roles.find((r) => r.templateId === templateId);
    expect(copy).toBeDefined(); // 平台角色模板被复制给了租户

    expect(await owner.tenantMenuGrant.count({ where: { tenantId: t.tenantId, menuId } })).toBe(1); // 默认授权全部平台菜单

    const admin = await owner.account.findFirstOrThrow({ where: { tenantId: t.tenantId, isBuiltinAdmin: true }, include: { roles: true } });
    expect(admin).toMatchObject({ username: "admin", personId: null, status: "pending" });
    expect(admin.keycloakUserId).toBeTruthy();
    expect(admin.roles).toHaveLength(1);
    expect(await keycloak.findUser(realmName("tenant", t.code), "admin")).not.toBeNull();

    expect(t.inviteSent).toBe(true);
    expect(await mailTo(t.adminEmail)).toBe(true);
  });

  it("running it again changes nothing", async () => {
    const t = await provisionTestTenant(owner, keycloak);
    codes.push(t.code);
    const counts = async () =>
      Promise.all([
        owner.campus.count({ where: { tenantId: t.tenantId } }),
        owner.dept.count({ where: { tenantId: t.tenantId } }),
        owner.role.count({ where: { tenantId: t.tenantId } }),
        owner.account.count({ where: { tenantId: t.tenantId } }),
        owner.tenantMenuGrant.count({ where: { tenantId: t.tenantId } }),
      ]);
    const before = await counts();
    const again = await provisionTestTenant(owner, keycloak, t.code);
    expect(again).toMatchObject({ created: false, tenantId: t.tenantId, steps: ["already provisioned"] });
    expect(await counts()).toEqual(before);
  });

  it("can be retried after a failure part-way, without duplicates", async () => {
    const code = randomCode();
    codes.push(code);
    const input = { code, name: `Retry ${code}`, adminEmail: `admin@${code}.example.test`, allowDirectGrant: true };

    // 第一次：Keycloak 建域失败（在租户记录建好之后）
    const broken = Object.create(keycloak) as KeycloakAdmin;
    broken.createRealm = async () => {
      throw new Error("keycloak down");
    };
    await expect(new ProvisioningService(owner, broken).provision(input)).rejects.toThrow("keycloak down");
    const half = await owner.tenant.findUniqueOrThrow({ where: { code } });
    expect(half.status).toBe("provisioning");

    // 第二次：第一步之后又在"建管理员用户"处失败
    const broken2 = Object.create(keycloak) as KeycloakAdmin;
    broken2.createUser = async () => {
      throw new Error("keycloak user api down");
    };
    await expect(new ProvisioningService(owner, broken2).provision(input)).rejects.toThrow("keycloak user api down");
    expect((await owner.tenant.findUniqueOrThrow({ where: { code } })).status).toBe("provisioning");

    // 第三次：正常，补完剩下的
    const done = await new ProvisioningService(owner, keycloak).provision(input);
    expect(done.created).toBe(false); // 租户记录是第一次建的
    expect((await owner.tenant.findUniqueOrThrow({ where: { code } })).status).toBe("active");
    expect(await owner.campus.count({ where: { tenantId: half.id } })).toBe(1);
    expect(await owner.account.count({ where: { tenantId: half.id, isBuiltinAdmin: true } })).toBe(1);
    expect(await owner.role.count({ where: { tenantId: half.id, kind: "tenant_admin" } })).toBe(1);
    expect(await keycloak.realmExists(realmName("tenant", code))).toBe(true);
  });

  it("an invite email failure does not fail the provisioning", async () => {
    const code = randomCode();
    codes.push(code);
    const noMail = Object.create(keycloak) as KeycloakAdmin;
    noMail.sendInvite = async () => {
      throw new Error("smtp unavailable");
    };
    const result = await new ProvisioningService(owner, noMail).provision({ code, name: code, adminEmail: `admin@${code}.example.test`, allowDirectGrant: true });
    expect(result.inviteSent).toBe(false);
    expect(result.inviteError).toMatch(/smtp unavailable/);
    expect((await owner.tenant.findUniqueOrThrow({ where: { code } })).status).toBe("active");
  });

  it("refuses reserved words and malformed codes without creating anything", async () => {
    const svc = new ProvisioningService(owner, keycloak);
    for (const code of ["platform", "admin", "www", "Bad_Code", "a", "x--y"]) {
      await expect(svc.provision({ code, name: "X", adminEmail: "x@example.test" })).rejects.toThrow(/invalid tenant code/);
      expect(await owner.tenant.findUnique({ where: { code } })).toBeNull();
    }
  });

  it("the tenant code cannot be changed once created", async () => {
    const t = await provisionTestTenant(owner, keycloak);
    codes.push(t.code);
    await expect(owner.tenant.update({ where: { id: t.tenantId }, data: { code: randomCode() } })).rejects.toThrow(/immutable/);
    await expect(owner.$executeRaw`UPDATE biz.tenant SET code = 'changed' WHERE id = ${t.tenantId}::uuid`).rejects.toThrow(/immutable/);
    expect((await owner.tenant.findUniqueOrThrow({ where: { id: t.tenantId } })).code).toBe(t.code);
  });
});
