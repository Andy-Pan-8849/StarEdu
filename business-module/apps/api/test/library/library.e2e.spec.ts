// 文档库：最终权限 = 操作权限 ∧ 文件夹访问级别；多处授权取并集、没有"拒绝"；机密文件夹的特殊规则；
// 文件夹移动/删除的约束；文件复制/移动；授权到期；祖先数组。
import { Harness, type TestUser } from "../helpers/app";

describe("document library", () => {
  const h = new Harness();
  let hqDept: string;
  let hr: string;
  let boss: string;
  let teacher: TestUser;
  let tTok: string;
  let acad: string;
  let stu: string;
  let hrUser: TestUser;
  const hrc = () => h.call(hr);
  const as = (t: string) => h.call(t);

  async function folder(tok: string, body: Record<string, unknown>) {
    const res = await h.call(tok).post("/api/library/folders", body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  }
  async function upload(tok: string, folderId: string, name: string, text = "hello", fileId?: string) {
    const bytes = Buffer.from(text);
    const res = await h.call(tok).post(`/api/library/folders/${folderId}/uploads`, { name, size: bytes.length, contentType: "text/plain", fileId });
    if (res.status !== 201) return { status: res.status, id: null as string | null };
    const put = await fetch(res.body.uploadUrl, { method: "PUT", headers: res.body.headers, body: bytes });
    expect(put.status).toBe(200);
    const done = await h.call(tok).post(`/api/library/folders/${folderId}/uploads/confirm`, { uploadId: res.body.uploadId });
    return { status: done.status, id: (done.body.id ?? null) as string | null, body: done.body };
  }

  beforeAll(async () => {
    await h.start();
    const campus = await h.owner.campus.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, type: "hq" } });
    hqDept = campus.deptId;
    hrUser = await h.user("hr.one", { roles: ["hr-manager"], person: "staff", deptIds: [hqDept] });
    hr = await hrUser.token();
    boss = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
    teacher = await h.user("teach", { roles: ["teacher"], person: "staff", deptIds: [hqDept] });
    tTok = await teacher.token();
    acad = await (await h.user("acad", { roles: ["academic-manager"], person: "staff", deptIds: [hqDept] })).token();
    stu = await (await h.user("stu1", { roles: ["student"], person: "student" })).token();
  });
  afterAll(() => h.stop());

  describe("classification and default access", () => {
    it("internal folders are for all staff; public ones for everyone including students; students never see internal", async () => {
      const policies = await folder(hr, { name: "Policies", classification: "internal" });
      const pub = await folder(hr, { name: "Handbook", classification: "public" });
      expect((await as(tTok).get("/api/library/folders")).body.map((f: { name: string }) => f.name).sort()).toEqual(["Handbook", "Policies"]);
      expect((await as(tTok).get(`/api/library/folders/${policies}`)).body.level).toBe("view");
      const sf = await as(stu).get("/api/portal/library/folders");
      expect(sf.body.map((f: { name: string }) => f.name)).toEqual(["Handbook"]);
      expect((await as(stu).get(`/api/portal/library/folders/${policies}/files`)).status).toBe(404);
      expect((await as(stu).get(`/api/portal/library/folders/${pub}/files`)).status).toBe(200);
    });

    it("top-level folders need their own permission", async () => {
      expect((await as(acad).post("/api/library/folders", { name: "Mine" })).status).toBe(403);
      expect((await hrc().post("/api/library/folders", { name: "Root ok" })).status).toBe(201);
    });

    it("names are unique per parent, case-insensitively", async () => {
      await folder(hr, { name: "Dup" });
      expect((await hrc().post("/api/library/folders", { name: "dup" })).status).toBe(409);
    });
  });

  describe("final permission = operation permission and folder level", () => {
    let f: string;
    beforeAll(async () => {
      f = await folder(hr, { name: "Plans", classification: "internal", ownerDeptId: hqDept });
    });

    it("a teacher with the upload permission but only view access cannot upload; a manager can grant edit; grants add up", async () => {
      expect((await upload(tTok, f, "a.txt")).status).toBe(403);
      const add = await hrc().post(`/api/library/folders/${f}/acl`, { principalType: "user", principalId: teacher.accountId, level: "edit" });
      expect(add.status).toBe(201);
      const up = await upload(tTok, f, "a.txt", "one");
      expect(up.status).toBe(201);
      // 再按角色给 view：并集，仍然是 edit
      const role = await h.owner.role.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, code: "teacher" } });
      await hrc().post(`/api/library/folders/${f}/acl`, { principalType: "role", principalId: role.id, level: "view" });
      expect((await as(tTok).get(`/api/library/folders/${f}`)).body.level).toBe("edit");
      // 编辑级别只能动自己上传的文件
      const mine = up.id as string;
      const hrFile = (await upload(hr, f, "hr.txt")).id as string;
      expect((await as(tTok).patch(`/api/library/files/${mine}`, { name: "renamed.txt" })).status).toBe(200);
      expect((await as(tTok).patch(`/api/library/files/${hrFile}`, { name: "x.txt" })).status).toBe(403);
      expect((await as(tTok).del(`/api/library/files/${hrFile}`)).status).toBe(403);
      expect((await as(tTok).del(`/api/library/files/${mine}`)).status).toBe(403); // 老师模板没有"删除"按钮：操作权限先拦
    });

    it("the operation permission is checked first: without it, high folder access does not help", async () => {
      await hrc().post(`/api/library/folders/${f}/acl`, { principalType: "user", principalId: teacher.accountId, level: "manage" });
      expect((await as(tTok).post(`/api/library/folders/${f}/acl`, { principalType: "everyone", level: "view" })).status).toBe(403); // 老师模板没有"授权"按钮
      expect((await as(tTok).get(`/api/library/folders/${f}/log`)).status).toBe(403);
    });

    it("grants can expire; an expired grant stops working at once", async () => {
      const acadId = (await h.owner.account.findFirstOrThrow({ where: { tenantId: h.tenant.tenantId, username: "acad" } })).id;
      expect((await as(acad).get(`/api/library/folders/${f}`)).status).toBe(200); // 全体员工的默认授权
      const priv = await folder(hr, { name: "Auditor only", classification: "confidential" });
      expect((await as(acad).get(`/api/library/folders/${priv}`)).status).toBe(404);
      expect((await hrc().post(`/api/library/folders/${priv}/acl`, { principalType: "user", principalId: acadId, level: "view", expiresAt: "2020-01-01T00:00:00.000Z" })).status).toBe(400);
      const g = (await hrc().post(`/api/library/folders/${priv}/acl`, { principalType: "user", principalId: acadId, level: "view", expiresAt: new Date(Date.now() + 3600e3).toISOString() })).body;
      expect((await as(acad).get(`/api/library/folders/${priv}`)).status).toBe(200);
      await h.owner.docAcl.update({ where: { id: g.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await as(acad).get(`/api/library/folders/${priv}`)).status).toBe(404);
      const listed = (await hrc().get(`/api/library/folders/${priv}/acl`)).body.items.find((i: { id: string }) => i.id === g.id);
      expect(listed.expired).toBe(true);
    });

    it("the last manager cannot be removed", async () => {
      const g = await folder(hr, { name: "Solo" });
      const acl = (await hrc().get(`/api/library/folders/${g}/acl`)).body.items;
      const manager = acl.find((i: { level: string }) => i.level === "manage");
      expect((await hrc().del(`/api/library/folders/${g}/acl/${manager.id}`)).status).toBe(409);
    });
  });

  describe("confidential folders", () => {
    let c: string;
    let file: string;
    beforeAll(async () => {
      c = await folder(hr, { name: "Student records", classification: "confidential", ownerDeptId: hqDept });
      file = (await upload(hr, c, "records.txt", "secret")).id as string;
    });

    it("have no default grants, no inheritance, always log; staff and even the admin cannot see them", async () => {
      const f = (await hrc().get(`/api/library/folders/${c}`)).body;
      expect(f).toMatchObject({ inheritAcl: false, logAccess: true, classification: "confidential" });
      const acl = (await hrc().get(`/api/library/folders/${c}/acl`)).body.items;
      expect(acl).toHaveLength(1);
      expect(acl[0]).toMatchObject({ principalType: "user", level: "manage", source: "manual" });
      expect((await as(tTok).get(`/api/library/folders/${c}`)).status).toBe(404);
      expect((await as(boss).get(`/api/library/folders/${c}`)).status).toBe(404);
      expect((await as(boss).get("/api/library/folders")).body.map((x: { name: string }) => x.name)).not.toContain("Student records");
      expect((await hrc().post(`/api/library/folders/${c}/acl`, { principalType: "all_staff", level: "view" })).status).toBe(400);
    });

    it("an admin can grant themselves access only with a reason, and it is logged", async () => {
      expect((await as(boss).post(`/api/library/folders/${c}/self-grant`, { reason: "x" })).status).toBe(400);
      expect((await as(boss).post(`/api/library/folders/${c}/self-grant`, { reason: "Annual audit of records" })).status).toBe(201);
      expect((await as(boss).get(`/api/library/folders/${c}`)).status).toBe(200);
      const log = (await hrc().get(`/api/library/folders/${c}/log`)).body;
      expect(log.map((l: { action: string }) => l.action)).toContain("acl.self_grant");
      expect(log.find((l: { action: string }) => l.action === "acl.self_grant").detail.reason).toBe("Annual audit of records");
    });

    it("every view and download is logged; the preview carries a watermark", async () => {
      const p = await hrc().get(`/api/library/files/${file}/preview`);
      expect(p.status).toBe(200);
      expect(p.body.watermark).toMatch(/hr\.one/);
      expect((await hrc().get(`/api/library/files/${file}/download`)).status).toBe(200);
      const actions = (await hrc().get(`/api/library/folders/${c}/log`)).body.map((l: { action: string }) => l.action);
      expect(actions).toEqual(expect.arrayContaining(["file.view", "file.download", "file.upload"]));
    });

    it("view-only folders refuse downloads and copies, and the refusal is logged", async () => {
      expect((await hrc().patch(`/api/library/folders/${c}`, { previewOnly: true })).status).toBe(200);
      expect((await hrc().get(`/api/library/files/${file}/download`)).status).toBe(403);
      expect((await hrc().get(`/api/library/files/${file}/preview`)).body.viewOnly).toBe(true);
      const other = await folder(hr, { name: "Elsewhere" });
      expect((await hrc().post(`/api/library/files/${file}/copy`, { targetId: other })).status).toBe(403);
      expect((await hrc().get(`/api/library/folders/${c}/log`)).body.map((l: { action: string }) => l.action)).toContain("file.download_refused");
      expect((await hrc().patch(`/api/library/folders/${c}`, { previewOnly: false })).status).toBe(200);
    });

    it("lowering the classification, or moving a file out, needs confirmation", async () => {
      expect((await hrc().patch(`/api/library/folders/${c}`, { classification: "internal" })).status).toBe(409);
      const low = await folder(hr, { name: "Lower", classification: "internal" });
      expect((await hrc().post(`/api/library/files/${file}/move`, { targetId: low })).status).toBe(409);
      expect((await hrc().post(`/api/library/files/${file}/move`, { targetId: low, confirm: true })).status).toBe(201);
    });
  });

  describe("folder tree", () => {
    let a: string;
    let b: string;
    let c: string;
    beforeAll(async () => {
      a = await folder(hr, { name: "Tree A" });
      b = await folder(hr, { name: "Tree B", parentId: a });
      c = await folder(hr, { name: "Tree C", parentId: b });
    });

    it("keeps an ancestor array that follows moves", async () => {
      expect((await h.owner.docFolder.findUniqueOrThrow({ where: { id: c } })).ancestors).toEqual([a, b, c]);
      const other = await folder(hr, { name: "Tree D" });
      expect((await hrc().post(`/api/library/folders/${b}/move`, { targetId: other, confirm: true })).status).toBe(201);
      expect((await h.owner.docFolder.findUniqueOrThrow({ where: { id: c } })).ancestors).toEqual([other, b, c]);
    });

    it("cannot move into its own subtree; moving needs manage on both ends; inheriting folders need confirmation", async () => {
      const root = (await h.owner.docFolder.findUniqueOrThrow({ where: { id: b } })).parentId as string;
      expect((await hrc().post(`/api/library/folders/${root}/move`, { targetId: c, confirm: true })).status).toBe(400);
      expect((await hrc().post(`/api/library/folders/${c}/move`, { targetId: root })).status).toBe(409);
      const mine = await folder(hr, { name: "Not yours" });
      await hrc().post(`/api/library/folders/${mine}/acl`, { principalType: "user", principalId: teacher.accountId, level: "view" });
      expect((await as(tTok).post(`/api/library/folders/${c}/move`, { targetId: mine, confirm: true })).status).toBe(403);
    });

    it("only empty folders can be deleted", async () => {
      const f = await folder(hr, { name: "Has stuff" });
      const sub = await folder(hr, { name: "Sub", parentId: f });
      expect((await hrc().del(`/api/library/folders/${f}`)).status).toBe(409);
      const file = (await upload(hr, sub, "x.txt")).id as string;
      expect((await hrc().del(`/api/library/folders/${sub}`)).status).toBe(409);
      await hrc().del(`/api/library/files/${file}`);
      expect((await hrc().del(`/api/library/folders/${sub}`)).status).toBe(200); // 文件是软删除，对用户来说已经没有文件了
    });
  });

  describe("files", () => {
    it("rejects bad types and sizes, keeps versions, and refuses duplicate names", async () => {
      const f = await folder(hr, { name: "Files" });
      expect((await hrc().post(`/api/library/folders/${f}/uploads`, { name: "evil.exe", size: 10, contentType: "application/octet-stream" })).status).toBe(400);
      expect((await hrc().post(`/api/library/folders/${f}/uploads`, { name: "big.pdf", size: 10 ** 10, contentType: "application/pdf" })).status).toBe(400);
      const first = await upload(hr, f, "doc.txt", "v1");
      expect(first.status).toBe(201);
      expect((await upload(hr, f, "DOC.txt", "dup")).status).toBe(409);
      const v2 = await upload(hr, f, "doc.txt", "version two", first.id as string);
      expect(v2.body.version).toBe(2);
      expect((await hrc().get(`/api/library/files/${first.id}/versions`)).body.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      const missing = await hrc().post(`/api/library/folders/${f}/uploads`, { name: "ghost.txt", size: 5, contentType: "text/plain" });
      expect((await hrc().post(`/api/library/folders/${f}/uploads/confirm`, { uploadId: missing.body.uploadId })).status).toBe(400);
    });

    it("copy needs view on the source and edit on the target; move also needs to be allowed to delete", async () => {
      const src = await folder(hr, { name: "Src" });
      const dst = await folder(hr, { name: "Dst" });
      const file = (await upload(hr, src, "m.txt")).id as string;
      await hrc().post(`/api/library/folders/${dst}/acl`, { principalType: "user", principalId: teacher.accountId, level: "edit" });
      // 老师对源只有查看（内部文件夹默认），对目标有编辑
      expect((await as(tTok).post(`/api/library/files/${file}/copy`, { targetId: dst })).status).toBe(201);
      expect((await as(tTok).post(`/api/library/files/${file}/move`, { targetId: dst })).status).toBe(403);
      expect((await hrc().post(`/api/library/files/${file}/copy`, { targetId: dst })).status).toBe(409); // 目标里已有同名文件
      expect((await hrc().post(`/api/library/files/${file}/move`, { targetId: dst })).status).toBe(409);
      const empty = await folder(hr, { name: "Empty" });
      expect((await hrc().post(`/api/library/files/${file}/move`, { targetId: empty })).status).toBe(201);
      expect((await hrc().get(`/api/library/folders/${src}/files`)).body).toHaveLength(0);
    });
  });
});
