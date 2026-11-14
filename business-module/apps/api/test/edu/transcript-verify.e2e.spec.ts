// 成绩单验真：每份成绩单有二维码链接和内容指纹；公开验真页（不登录）只显示生成当时的要点；
// 可以作废；别的租户的令牌查不到；按来源限速；B18 之前生成的旧成绩单也能验证"这份文档存在"。
import { Harness } from "../helpers/app";

describe("transcript verification", () => {
  const h = new Harness();
  let reg: string;
  let stu: string;
  let studentId: string;
  const registrar = () => h.call(reg);
  const verify = (token: string, host?: string) => h.call(null, host).get(`/api/public/transcripts/${token}`);

  beforeAll(async () => {
    await h.start();
    reg = await (await h.user("registrar", { roles: ["academic-manager"], person: "staff" })).token();
    const s = await h.user("vt.student", { roles: ["student"], person: "student" });
    stu = await s.token();
    studentId = s.personId!;
  });
  afterAll(() => h.stop());

  it("an issued transcript records a random token, a content fingerprint and a snapshot", async () => {
    expect((await h.call(stu).get("/api/portal/transcript.pdf")).status).toBe(200);
    const issue = await h.owner.transcriptIssue.findFirstOrThrow({ where: { studentPersonId: studentId, version: "informal" } });
    expect(issue.verifyToken).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(issue.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issue.snapshot).toMatchObject({ studentName: "vt.student", creditsEarned: 0 });
  });

  it("anyone with the link sees the facts as issued, marked official or unofficial, with the student number mostly hidden", async () => {
    const informal = await h.owner.transcriptIssue.findFirstOrThrow({ where: { studentPersonId: studentId, version: "informal" } });
    const res = await verify(informal.verifyToken);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ docNumber: informal.docNumber, official: false, version: "informal", status: "valid", fingerprint: informal.contentHash!.slice(0, 16).toUpperCase() });
    expect(res.body.details).toMatchObject({ studentName: "vt.student", cumulativeGpa: null, creditsEarned: 0 });
    expect(res.body.details.studentNo).toMatch(/^\*+[^*]{3}$/);
    expect(JSON.stringify(res.body)).not.toContain("S-vt.student"); // 完整学号不出现
    expect(res.body.details.terms).toBeUndefined(); // 没有逐门课成绩

    expect((await registrar().post(`/api/transcripts/${studentId}/formal`)).status).toBe(201);
    const formal = await h.owner.transcriptIssue.findFirstOrThrow({ where: { studentPersonId: studentId, version: "formal" } });
    expect((await verify(formal.verifyToken)).body).toMatchObject({ official: true, version: "formal", status: "valid" });
    // 管理端的列表带验真链接
    const view = (await registrar().get(`/api/transcripts/${studentId}`)).body;
    const row = view.issues.find((i: { docNumber: string }) => i.docNumber === formal.docNumber);
    expect(row.verifyUrl).toMatch(new RegExp(`/verify/${formal.verifyToken}$`));
    expect(row).toMatchObject({ verifiable: true, revokedAt: null });
  });

  it("unknown, malformed and other tenants' tokens are all just 404", async () => {
    expect((await verify("A".repeat(24))).status).toBe(404);
    expect((await verify("short")).status).toBe(404);
    const formal = await h.owner.transcriptIssue.findFirstOrThrow({ where: { studentPersonId: studentId, version: "formal" } });
    const other = await h.extraTenant();
    expect((await verify(formal.verifyToken, `${other.code}.localhost`)).status).toBe(404);
  });

  it("revoking marks it revoked at once; needs the issue permission and a reason; the student cannot", async () => {
    const formal = await h.owner.transcriptIssue.findFirstOrThrow({ where: { studentPersonId: studentId, version: "formal" } });
    expect((await h.call(stu).post(`/api/transcripts/issues/${formal.id}/revoke`, { reason: "x" })).status).toBe(403);
    expect((await registrar().post(`/api/transcripts/issues/${formal.id}/revoke`, {})).status).toBe(400);
    expect((await registrar().post(`/api/transcripts/issues/11111111-1111-4111-8111-111111111111/revoke`, { reason: "x" })).status).toBe(404);
    const res = await registrar().post(`/api/transcripts/issues/${formal.id}/revoke`, { reason: "Issued to the wrong student record" });
    expect(res.status).toBe(201);
    const after = (await verify(formal.verifyToken)).body;
    expect(after.status).toBe("revoked");
    expect(after.revokedAt).toBeTruthy();
    expect(await h.owner.auditLog.count({ where: { tenantId: h.tenant.tenantId, action: "transcript.revoke" } })).toBe(1);
    expect((await registrar().post(`/api/transcripts/issues/${formal.id}/revoke`, { reason: "again" })).status).toBe(201); // 重复作废不改变结果
    const row = (await registrar().get(`/api/transcripts/${studentId}`)).body.issues.find((i: { id: string }) => i.id === formal.id);
    expect(row).toMatchObject({ revokeReason: "Issued to the wrong student record" });
  });

  it("a transcript issued before verification existed is confirmed as existing, without details", async () => {
    const legacy = await h.owner.transcriptIssue.create({ data: { tenantId: h.tenant.tenantId, studentPersonId: studentId, docNumber: "TR-2025-000001", version: "formal", verifyToken: "legacytokenlegacytoken123456" } });
    const res = await verify(legacy.verifyToken);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ docNumber: "TR-2025-000001", status: "valid", fingerprint: null, details: null });
  });

  it("limits how fast one address can try tokens", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await verify("B".repeat(24))).status);
    expect(codes).toContain(429);
    expect(codes[0]).toBe(404);
  });
});
