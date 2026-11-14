// 需求文档示例数据（直营店租户，上海、北京两个校区）的判定例逐条验证。
import { Harness } from "../helpers/app";

describe("document library: the sample company", () => {
  const h = new Harness();
  let hr: string;
  let lilei: string; // 教务专员：上海教务处的老师角色
  let bjTeacher: string;
  let wang: string; // 校长
  let chen: string; // 审计
  const ids: Record<string, string> = {};
  const as = (t: string) => h.call(t);
  const names = async (t: string) => ((await as(t).get("/api/library/folders")).body as Array<{ name: string }>).map((f) => f.name).sort();
  const mk = async (name: string, body: Record<string, unknown>) => {
    const res = await as(hr).post("/api/library/folders", { name, ...body });
    expect(res.status).toBe(201);
    ids[name] = res.body.id;
    return res.body.id as string;
  };
  const grant = async (folder: string, body: Record<string, unknown>) => expect((await as(hr).post(`/api/library/folders/${ids[folder]}/acl`, body)).status).toBe(201);

  beforeAll(async () => {
    await h.start();
    const t = h.tenant.tenantId;
    const hq = (await h.owner.campus.findFirstOrThrow({ where: { tenantId: t, type: "hq" } })).deptId;
    const dept = async (name: string, parentId: string) => (await h.owner.dept.create({ data: { tenantId: t, name, parentId } })).id;
    const sh = await dept("Shanghai", hq);
    const shAcad = await dept("Shanghai academic office", sh);
    const shFin = await dept("Shanghai finance", sh);
    const bj = await dept("Beijing", hq);
    hr = await (await h.user("hr.boss", { roles: ["hr-manager"], person: "staff", deptIds: [hq] })).token();
    lilei = await (await h.user("lilei", { roles: ["teacher"], person: "staff", deptIds: [shAcad] })).token();
    bjTeacher = await (await h.user("bj.teacher", { roles: ["teacher"], person: "staff", deptIds: [bj] })).token();
    const wangU = await h.user("wang", { roles: ["campus-lead"], person: "staff", deptIds: [sh] });
    wang = await wangU.token();
    const chenU = await h.user("chen", { roles: ["academic-manager"], person: "staff", deptIds: [hq] });
    chen = await chenU.token();
    const role = (code: string) => h.owner.role.findFirstOrThrow({ where: { tenantId: t, code } });

    await mk("Public", { classification: "public" });
    await mk("HQ policies", { classification: "internal" });
    await mk("Shanghai", { classification: "internal", ownerDeptId: sh });
    await mk("Academic office", { classification: "internal", ownerDeptId: shAcad, parentId: ids["Shanghai"] });
    await mk("Timetable plans", { classification: "internal", parentId: ids["Academic office"], ownerDeptId: shAcad });
    await mk("Student records", { classification: "confidential", ownerDeptId: shAcad, parentId: ids["Academic office"] });
    await mk("Finance", { classification: "confidential", ownerDeptId: shFin, parentId: ids["Shanghai"] });
    await mk("Beijing", { classification: "internal", ownerDeptId: bj });
    await grant("Academic office", { principalType: "dept", principalId: shAcad, includeSub: true, level: "edit" });
    await grant("Student records", { principalType: "role", principalId: (await role("academic-manager")).id, level: "edit" });
    await grant("Student records", { principalType: "user", principalId: wangU.accountId, level: "view" });
    await grant("Finance", { principalType: "role", principalId: (await role("hr-manager")).id, level: "manage" });
    await grant("Finance", { principalType: "user", principalId: chenU.accountId, level: "view", expiresAt: new Date(Date.now() + 86400e3).toISOString() });
  });
  afterAll(() => h.stop());

  it("a registrar's assistant edits the timetable plans but cannot see the student records or finance", async () => {
    expect((await as(lilei).get(`/api/library/folders/${ids["Timetable plans"]}`)).body.level).toBe("edit");
    expect((await as(lilei).get(`/api/library/folders/${ids["Student records"]}`)).status).toBe(404);
    expect((await as(lilei).get(`/api/library/folders/${ids["Finance"]}`)).status).toBe(404);
    const up = await as(lilei).post(`/api/library/folders/${ids["Timetable plans"]}/uploads`, { name: "plan.pdf", size: 5, contentType: "application/pdf" });
    expect(up.status).toBe(201);
    expect((await as(lilei).post(`/api/library/folders/${ids["Student records"]}/uploads`, { name: "x.pdf", size: 5, contentType: "application/pdf" })).status).toBe(404);
  });

  it("a Beijing teacher sees only the public materials, the headquarters policies and their own campus folder", async () => {
    expect(await names(bjTeacher)).toEqual(["Beijing", "HQ policies", "Public"]);
  });

  it("the principal sees the student records (view only); the registrar's role edits them", async () => {
    expect((await as(wang).get(`/api/library/folders/${ids["Student records"]}`)).body.level).toBe("view");
    expect((await as(wang).get(`/api/library/folders/${ids["Finance"]}`)).status).toBe(404);
    expect((await as(chen).get(`/api/library/folders/${ids["Student records"]}`)).body.level).toBe("edit");
  });

  it("the auditor's access to finance ends by itself", async () => {
    expect((await as(chen).get(`/api/library/folders/${ids["Finance"]}`)).body.level).toBe("view");
    await h.owner.docAcl.updateMany({ where: { folderId: ids["Finance"], expiresAt: { not: null } }, data: { expiresAt: new Date("2026-12-31T00:00:00Z") } });
    await h.owner.docAcl.updateMany({ where: { folderId: ids["Finance"], expiresAt: { not: null } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await as(chen).get(`/api/library/folders/${ids["Finance"]}`)).status).toBe(404);
  });
});
