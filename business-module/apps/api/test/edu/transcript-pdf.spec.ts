// 成绩单 PDF 的字体：中文名字用仓库自带的 Noto Sans SC 子集，字体里没有的字不报错、显示成"?"。
import { existsSync, statSync } from "node:fs";
import { BUNDLED_FONT, TranscriptService, type Transcript } from "../../src/edu/transcript.service";

const transcript = (name: string): Transcript => ({
  student: { personId: "p", fullName: name, studentNo: "S-1", campus: "StarIT北京总部", status: "enrolled", major: "计算机科学" },
  terms: [{ termId: "t", name: "2026 秋季", startDate: "2026-09-01", gpa: 3.5, creditsAttempted: 3, creditsEarned: 3, rows: [{ enrollmentId: "e", courseCode: "CS101", courseName: "程序设计基础", sectionName: "s", credits: 3, state: "graded", total: 91.5, grade: "A", gradePoints: 4, passed: true, replaced: false }] }],
  cumulative: { gpa: 3.5, creditsAttempted: 3, creditsEarned: 3 },
});
const meta = { version: "informal" as const, docNumber: "TR-2026-000001", generatedAt: new Date("2026-11-13"), institution: "StarIT 教育" };
const svc = new TranscriptService(null as never);

describe("transcript PDF font", () => {
  it("ships the font file, under the repository's 2 MB limit", () => {
    expect(existsSync(BUNDLED_FONT)).toBe(true);
    expect(statSync(BUNDLED_FONT).size).toBeLessThan(2 * 1024 * 1024);
  });

  it("embeds Noto Sans SC for Chinese text", async () => {
    const pdf = await svc.pdf(transcript("李伟"), meta);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.toString("latin1")).toContain("NotoSansSC");
  });

  it("does not fail on a character the subset does not have", async () => {
    const pdf = await svc.pdf(transcript("龘 Li"), meta);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("adds the verification QR and fingerprint without breaking the document; the fingerprint follows the content", async () => {
    const plain = await svc.pdf(transcript("Li"), meta);
    const withQr = await svc.pdf(transcript("Li"), { ...meta, verify: { url: "http://hq.localhost:3001/verify/abcdefghijklmnopqrstuvwx", fingerprint: "0123456789ABCDEF" } });
    expect(withQr.subarray(0, 4).toString()).toBe("%PDF");
    expect(withQr.length).toBeGreaterThan(plain.length);
    const a = svc.fingerprint(transcript("Li"));
    expect(svc.fingerprint(transcript("Li")).full).toBe(a.full);
    expect(a.short).toMatch(/^[0-9A-F]{16}$/);
    expect(svc.fingerprint(transcript("Lee")).full).not.toBe(a.full);
    expect(svc.verifyUrl("hq", "tok")).toMatch(/\/verify\/tok$/);
  });
});
