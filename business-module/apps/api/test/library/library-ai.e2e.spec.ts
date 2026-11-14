// AI 知识库对齐（B12）：AI 问"这个用户能读哪些文件夹"，答案必须和文档库自己的可见性一致（同一套规则），
// 只是"仅在线查看"的文件夹不给 AI；文件变化发事件；知识库入库用的文件接口只认服务密钥且分租户。
import { Harness } from "../helpers/app";

const KEY = "test-internal-key";

describe("document library: AI knowledge base alignment", () => {
  const h = new Harness();
  let hr: string;
  let teacher: string;
  let student: string;
  let admin: string;
  let outsider: string; // 没有任何文档库权限的账号
  let teacherId: string;
  const ids: Record<string, string> = {};
  const as = (t: string | null) => h.call(t);
  const aiIds = async (t: string): Promise<string[]> => {
    const res = await as(t).post("/api/internal/library-access").set("x-internal-key", KEY);
    expect(res.status).toBe(200);
    return (res.body.folderIds as string[]).sort();
  };
  const libIds = async (t: string, portal = false): Promise<Array<{ id: string; previewOnly?: boolean }>> =>
    (await as(t).get(portal ? "/api/portal/library/folders" : "/api/library/folders")).body;
  const mk = async (name: string, body: Record<string, unknown>) => {
    const res = await as(hr).post("/api/library/folders", { name, ...body });
    expect(res.status).toBe(201);
    ids[name] = res.body.id;
  };

  beforeAll(async () => {
    process.env.INTERNAL_API_KEY = KEY;
    process.env.BIZ_EVENT_BUS = "kafka";
    await h.start();
    const t = h.tenant.tenantId;
    const hq = (await h.owner.campus.findFirstOrThrow({ where: { tenantId: t, type: "hq" } })).deptId;
    hr = await (await h.user("hr.boss", { roles: ["hr-manager"], person: "staff", deptIds: [hq] })).token();
    const tUser = await h.user("teach", { roles: ["teacher"], person: "staff", deptIds: [hq] });
    teacher = await tUser.token();
    teacherId = tUser.accountId;
    student = await (await h.user("stud", { roles: ["student"], person: "student" })).token();
    admin = await (await h.user("boss", { roles: ["tenant-admin"], person: "staff" })).token();
    outsider = await (await h.user("nobody", { roles: [], person: "staff" })).token();
    await mk("Public", { classification: "public" });
    await mk("Policies", { classification: "internal" });
    await mk("Records", { classification: "confidential" });
    await mk("Sealed", { classification: "confidential" });
    expect((await as(hr).patch(`/api/library/folders/${ids["Sealed"]}`, { previewOnly: true })).status).toBe(200);
    await as(hr).post(`/api/library/folders/${ids["Sealed"]}/acl`, { principalType: "user", principalId: teacherId, level: "view" });
    await as(hr).post(`/api/library/folders/${ids["Records"]}/acl`, { principalType: "user", principalId: teacherId, level: "view" });
  });
  afterAll(async () => {
    delete process.env.INTERNAL_API_KEY;
    delete process.env.BIZ_EVENT_BUS;
    await h.stop();
  });

  it("needs the service key and a valid token", async () => {
    expect((await as(teacher).post("/api/internal/library-access")).status).toBe(403);
    expect((await as(null).post("/api/internal/library-access").set("x-internal-key", KEY)).status).toBe(401);
  });

  it("gives the same folders the library shows the user (except view-only folders), staff and students alike", async () => {
    for (const [token, portal] of [[hr, false], [teacher, false], [admin, false], [student, true]] as const) {
      const shown = (await libIds(token, portal)).filter((f) => f.previewOnly !== true).map((f) => f.id).sort();
      expect(await aiIds(token)).toEqual(shown);
    }
    expect(await aiIds(student)).toEqual([ids["Public"]]);
    expect(await aiIds(teacher)).toEqual([ids["Policies"], ids["Public"], ids["Records"]].sort()); // Sealed 是仅在线查看：文档库里看得到，AI 不给
  });

  it("confidential folders: the administrator gets nothing until a logged self-grant; the creator and the named teacher read them", async () => {
    expect(await aiIds(admin)).not.toContain(ids["Records"]);
    expect(await aiIds(hr)).toContain(ids["Records"]);
    expect(await aiIds(teacher)).toContain(ids["Records"]);
  });

  it("a view-only folder is never given to the AI (an answer would copy the content out)", async () => {
    expect(await aiIds(hr)).not.toContain(ids["Sealed"]);
    expect((await libIds(hr)).map((f) => f.id)).toContain(ids["Sealed"]);
  });

  it("without any library permission the answer is empty; a grant that expires stops counting at once", async () => {
    expect(await aiIds(outsider)).toEqual([]);
    const acl = await h.owner.docAcl.findFirstOrThrow({ where: { folderId: ids["Records"], principalType: "user", principalId: teacherId } });
    await h.owner.docAcl.update({ where: { id: acl.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await aiIds(teacher)).not.toContain(ids["Records"]);
    await h.owner.docAcl.update({ where: { id: acl.id }, data: { expiresAt: null } });
  });

  it("a settings change shows at the next question (live, not cached)", async () => {
    expect(await aiIds(teacher)).not.toContain(ids["Sealed"]);
    expect((await as(hr).patch(`/api/library/folders/${ids["Sealed"]}`, { previewOnly: false })).status).toBe(200);
    expect(await aiIds(teacher)).toContain(ids["Sealed"]);
    expect(await aiIds(student)).toEqual([ids["Public"]]);
  });

  it("file changes write an event with only the file id; the knowledge-base file interface is service-key only and per company", async () => {
    await h.owner.outboxEvent.deleteMany({ where: { tenantId: h.tenant.tenantId } });
    const folderId = ids["Policies"];
    const name = "handbook.txt";
    const body = Buffer.from("Leave policy: 5 days.");
    const up = await as(hr).post(`/api/library/folders/${folderId}/uploads`, { name, size: body.length, contentType: "text/plain" });
    expect(up.status).toBe(201);
    expect((await fetch(up.body.uploadUrl, { method: "PUT", headers: up.body.headers, body })).status).toBe(200);
    const done = await as(hr).post(`/api/library/folders/${folderId}/uploads/confirm`, { uploadId: up.body.uploadId });
    expect(done.status).toBe(201);
    const fileId = done.body.id as string;
    const events = await h.owner.outboxEvent.findMany({ where: { tenantId: h.tenant.tenantId, type: "library.file_changed" } });
    expect(events.map((e) => e.payload)).toEqual([{ fileId }]);

    expect((await as(null).get(`/api/internal/kb/files/${fileId}`)).status).toBe(403);
    const meta = await as(null).get(`/api/internal/kb/files/${fileId}`).set("x-internal-key", KEY);
    expect(meta.body).toMatchObject({ fileId, folderId, name, deleted: false, classification: "internal" });
    const content = await as(null).get(`/api/internal/kb/files/${fileId}/content`).set("x-internal-key", KEY).buffer(true);
    expect(content.status).toBe(200);
    expect(Buffer.from(content.body as Buffer).toString()).toBe("Leave policy: 5 days.");

    expect((await as(hr).del(`/api/library/files/${fileId}`)).status).toBe(200);
    expect(await h.owner.outboxEvent.count({ where: { tenantId: h.tenant.tenantId, type: "library.file_changed" } })).toBe(2);
    expect((await as(null).get(`/api/internal/kb/files/${fileId}`).set("x-internal-key", KEY)).body.deleted).toBe(true);
    expect((await as(null).get(`/api/internal/kb/files/${fileId}/content`).set("x-internal-key", KEY)).status).toBe(404);

    // 别的公司的文件：用本公司的地址取不到
    const other = await h.extraTenant();
    const foreign = await h.owner.docFolder.create({ data: { tenantId: other.tenantId, name: "Other", classification: "internal", ancestors: [] } });
    const foreignFile = await h.owner.docFile.create({ data: { tenantId: other.tenantId, folderId: foreign.id, name: "x.txt", storageKey: `tenant/${other.tenantId}/library/x.txt`, size: 1, contentType: "text/plain" } });
    expect((await as(null).get(`/api/internal/kb/files/${foreignFile.id}`).set("x-internal-key", KEY)).status).toBe(404);
    expect((await as(null).get(`/api/internal/kb/files/${foreignFile.id}/content`).set("x-internal-key", KEY)).status).toBe(404);
  });
});
