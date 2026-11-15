// 成绩单：内容（课程、学期、学分、等级、绩点、学期与累计 GPA、退课 W）、编号与生成记录、PDF。
//   - 只统计已发布的最终成绩；退课（W）列出但不计 GPA；进行中的列出但不计 GPA。
//   - 重修：同一门课最新一次替代旧的，旧记录标"已重修，不计 GPA"，学分只算一次。
//   - 非正式版（学生自助下载，页脚"仅供参考"）和正式版（教务生成）；每份有唯一文档编号，生成记录入库。
//   - PDF 用 pdfkit，全部用一种字体：仓库自带的 Noto Sans SC 子集（apps/api/assets/fonts，OFL 许可，含常用 3755 个汉字）。
//     字体里没有的字显示成"?"；要换字体，把环境变量 TRANSCRIPT_FONT_PATH 指向另一个 TTF/OTF 文件。
import { Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { existsSync } from "node:fs";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import { Prisma } from "../generated/prisma";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { requireTenant } from "../tenancy/request-scope";
import { tenantOrigin } from "../keycloak/realm-provisioner";
import { computeGpa, type GpaRow } from "./grade-calc";

export interface TranscriptRow {
  enrollmentId: string;
  courseCode: string;
  courseName: string;
  sectionName: string;
  credits: number;
  /** graded 已出成绩；withdrawn 退课 W；in_progress 进行中或成绩未发布 */
  state: "graded" | "withdrawn" | "in_progress";
  total: number | null;
  grade: string | null;
  gradePoints: number | null;
  passed: boolean | null;
  /** 已被重修替代：不计 GPA */
  replaced: boolean;
}
export interface Transcript {
  student: { personId: string; fullName: string; studentNo: string | null; campus: string | null; status: string | null; major: string | null };
  terms: Array<{ termId: string; name: string; startDate: string; rows: TranscriptRow[]; gpa: number | null; creditsAttempted: number; creditsEarned: number }>;
  cumulative: { gpa: number | null; creditsAttempted: number; creditsEarned: number };
}

/** 仓库自带的字体（src/edu 和 dist/edu 到 apps/api/assets 的相对位置相同）。 */
export const BUNDLED_FONT = join(__dirname, "../../assets/fonts/NotoSansSC-Regular-subset.ttf");

@Injectable()
export class TranscriptService {
  constructor(private readonly tenantDb: TenantPrismaService) {}

  private get db() {
    return this.tenantDb.db;
  }

  async build(personId: string): Promise<Transcript> {
    const person = await this.db.person.findUnique({ where: { id: personId } });
    if (!person) throw new NotFoundException();
    const profile = await this.db.studentProfile.findFirst({ where: { personId } });
    if (!profile) throw new NotFoundException();
    const [campus, declared] = await Promise.all([this.db.campus.findUnique({ where: { id: profile.campusId } }), this.db.studentMajor.findFirst({ where: { personId, kind: "primary", active: true } })]);
    const major = declared ? await this.db.major.findUnique({ where: { id: declared.majorId } }) : null;
    const enrollments = await this.db.enrollment.findMany({ where: { studentPersonId: personId, status: { in: ["enrolled", "completed", "withdrawn"] } }, include: { section: { include: { course: true, term: true } } } });
    const finals = new Map((await this.db.finalGrade.findMany({ where: { enrollmentId: { in: enrollments.map((e) => e.id) }, publishedAt: { not: null } } })).map((f) => [f.enrollmentId, f]));

    const gpaRows: GpaRow[] = [];
    for (const e of enrollments) {
      const f = finals.get(e.id);
      if (e.status !== "withdrawn" && f) gpaRows.push({ enrollmentId: e.id, courseId: e.section.courseId, termId: e.section.termId, termStart: e.section.term.startDate, enrolledAt: e.enrolledAt, credits: Number(e.section.course.credits), points: Number(f.gradePoints), passed: f.passed });
    }
    const gpa = computeGpa(gpaRows);
    const replaced = new Set(gpa.replaced);

    const byTerm = new Map<string, Transcript["terms"][number]>();
    for (const e of enrollments) {
      const t = e.section.term;
      if (!byTerm.has(t.id)) byTerm.set(t.id, { termId: t.id, name: t.name, startDate: t.startDate.toISOString().slice(0, 10), rows: [], gpa: gpa.byTerm[t.id]?.gpa ?? null, creditsAttempted: gpa.byTerm[t.id]?.attempted ?? 0, creditsEarned: gpa.byTerm[t.id]?.earned ?? 0 });
      const f = finals.get(e.id);
      const graded = e.status !== "withdrawn" && !!f;
      byTerm.get(t.id)!.rows.push({
        enrollmentId: e.id, courseCode: e.section.course.code, courseName: e.section.course.name, sectionName: e.section.name, credits: Number(e.section.course.credits),
        state: e.status === "withdrawn" ? "withdrawn" : graded ? "graded" : "in_progress",
        total: graded ? Number(f!.total) : null, grade: graded ? f!.grade : null, gradePoints: graded ? Number(f!.gradePoints) : null, passed: graded ? f!.passed : null, replaced: replaced.has(e.id),
      });
    }
    const terms = [...byTerm.values()].sort((a, b) => a.startDate.localeCompare(b.startDate));
    for (const t of terms) t.rows.sort((a, b) => a.courseCode.localeCompare(b.courseCode));
    return {
      student: { personId, fullName: person.fullName, studentNo: profile.studentNo, campus: campus?.name ?? null, status: profile.academicStatus, major: major?.name ?? null },
      terms,
      cumulative: { gpa: gpa.cumulative.gpa, creditsAttempted: gpa.cumulative.attempted, creditsEarned: gpa.cumulative.earned },
    };
  }

  /** 成绩单内容的指纹（SHA-256，取前 16 位十六进制印在成绩单上）；同样的内容永远得到同样的指纹。 */
  fingerprint(t: Transcript): { full: string; short: string } {
    const full = createHash("sha256").update(JSON.stringify(t)).digest("hex");
    return { full, short: full.slice(0, 16).toUpperCase() };
  }

  /** 验真页的链接（二维码里的内容）：租户自己的网址 + /verify/<令牌>。 */
  verifyUrl(tenantCode: string, token: string): string {
    return `${tenantOrigin(tenantCode)}/verify/${token}`;
  }

  /**
   * 登记一份成绩单：生成唯一文档编号（TR-年份-六位序号，撞号就重试）、验真令牌、内容指纹和要点快照。
   * 快照存的是生成当时的样子；之后成绩有变化，验真页仍显示这份文档当时的内容。
   */
  async issue(personId: string, version: "informal" | "formal", generatedBy: string | null, transcript: Transcript, institution: string): Promise<{ id: string; docNumber: string; generatedAt: Date; verifyToken: string; verifyUrl: string; fingerprint: string }> {
    const tenant = requireTenant("issue transcript");
    const year = new Date().getUTCFullYear();
    const fp = this.fingerprint(transcript);
    const snapshot = {
      institution,
      studentName: transcript.student.fullName,
      studentNo: transcript.student.studentNo,
      major: transcript.student.major,
      campus: transcript.student.campus,
      cumulativeGpa: transcript.cumulative.gpa,
      creditsEarned: transcript.cumulative.creditsEarned,
      creditsAttempted: transcript.cumulative.creditsAttempted,
      terms: transcript.terms.length,
    };
    for (let attempt = 0; attempt < 8; attempt++) {
      const seq = (await this.db.transcriptIssue.count()) + 1 + attempt;
      const docNumber = `TR-${year}-${String(seq).padStart(6, "0")}`;
      const verifyToken = randomBytes(18).toString("base64url");
      try {
        const r = await this.db.transcriptIssue.create({ data: { tenantId: tenant.tenantId, studentPersonId: personId, docNumber, version, generatedBy, verifyToken, contentHash: fp.full, snapshot } });
        return { id: r.id, docNumber, generatedAt: r.generatedAt, verifyToken, verifyUrl: this.verifyUrl(tenant.code, verifyToken), fingerprint: fp.short };
      } catch (err) {
        if ((err as { code?: string }).code !== "P2002") throw err;
      }
    }
    throw new Error("Could not allocate a transcript number");
  }

  /** 公开验真（不登录）：凭令牌查这份文档；只返回生成时的要点，学号遮住大部分。 */
  async verify(token: string) {
    const issue = await this.db.transcriptIssue.findFirst({ where: { verifyToken: token } });
    if (!issue) return null;
    const snap = issue.snapshot as null | { institution: string; studentName: string; studentNo: string | null; major: string | null; campus: string | null; cumulativeGpa: number | null; creditsEarned: number; creditsAttempted: number; terms: number };
    const mask = (no: string | null) => (no ? `${"*".repeat(Math.max(0, no.length - 3))}${no.slice(-3)}` : null);
    return {
      docNumber: issue.docNumber,
      version: issue.version,
      official: issue.version === "formal",
      issuedAt: issue.generatedAt,
      status: issue.revokedAt ? "revoked" : "valid",
      revokedAt: issue.revokedAt,
      fingerprint: issue.contentHash ? issue.contentHash.slice(0, 16).toUpperCase() : null,
      details: snap ? { institution: snap.institution, studentName: snap.studentName, studentNo: mask(snap.studentNo), major: snap.major, campus: snap.campus, cumulativeGpa: snap.cumulativeGpa, creditsEarned: snap.creditsEarned, creditsAttempted: snap.creditsAttempted } : null,
    };
  }

  async revoke(issueId: string, by: string | null, reason: string) {
    const issue = await this.db.transcriptIssue.findUnique({ where: { id: issueId } });
    if (!issue) throw new NotFoundException();
    if (issue.revokedAt) return issue;
    return this.db.transcriptIssue.update({ where: { id: issueId }, data: { revokedAt: new Date(), revokedBy: by, revokeReason: reason } });
  }

  async pdf(t: Transcript, meta: { version: "informal" | "formal"; docNumber: string; generatedAt: Date; institution: string; verify?: { url: string; fingerprint: string } }): Promise<Buffer> {
    const configured = process.env.TRANSCRIPT_FONT_PATH;
    const font = configured && existsSync(configured) ? configured : BUNDLED_FONT;
    const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Transcript ${meta.docNumber}` } });
    doc.registerFont("body", font);
    const body = () => doc.font("body").fontSize(9);
    // 字体里没有的字符换成"?"，免得出现空白方块
    const has = (cp: number): boolean => ((doc as unknown as { _font?: { font?: { hasGlyphForCodePoint?: (c: number) => boolean } } })._font?.font?.hasGlyphForCodePoint?.(cp)) ?? true;
    const text = (s: string) => [...s].map((c) => (c === "\n" || has(c.codePointAt(0)!) ? c : "?")).join("");
    // 水印：每一页斜着印淡淡的大字（非正式版"UNOFFICIAL COPY"，正式版"OFFICIAL"+文档编号），复印或截图后仍能看出是哪种
    const watermark = () => {
      doc.save();
      doc.rotate(-40, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font("body").fillColor("#000000").fillOpacity(0.07);
      const big = meta.version === "formal" ? "OFFICIAL" : "UNOFFICIAL COPY";
      doc.fontSize(meta.version === "formal" ? 90 : 64).text(big, 0, doc.page.height / 2 - 50, { align: "center", width: doc.page.width, lineBreak: false });
      doc.fontSize(18).text(meta.docNumber, 0, doc.page.height / 2 + 40, { align: "center", width: doc.page.width, lineBreak: false });
      doc.restore();
      doc.fillOpacity(1).fillColor("#000000");
    };
    doc.on("pageAdded", watermark);
    watermark();
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

    body().fontSize(16).text(text(meta.institution), { align: "center" });
    body().fontSize(13).text(meta.version === "formal" ? "Official Academic Transcript" : "Academic Transcript (unofficial)", { align: "center" });
    body().moveDown(0.5).text(`Document no. ${meta.docNumber}    Generated ${meta.generatedAt.toISOString().slice(0, 10)}`, { align: "center" });
    body().moveDown(1);
    body().text(text(`Student: ${t.student.fullName}    Student no.: ${t.student.studentNo ?? "-"}`));
    body().text(text(`Campus: ${t.student.campus ?? "-"}    Major: ${t.student.major ?? "-"}    Status: ${t.student.status ?? "-"}`));
    for (const term of t.terms) {
      body().moveDown(0.8).fontSize(10).text(text(term.name));
      for (const r of term.rows) {
        const result = r.state === "withdrawn" ? "W (withdrawn, not in GPA)" : r.state === "in_progress" ? "in progress" : `${r.grade}  ${r.total}%  ${r.gradePoints?.toFixed(1)} pts${r.replaced ? "  (retaken, not in GPA)" : ""}`;
        body().text(text(`${r.courseCode}  ${r.courseName}  [${r.credits} cr]  ${result}`), { indent: 10 });
      }
      body().text(`Term GPA ${term.gpa?.toFixed(2) ?? "-"}   credits attempted ${term.creditsAttempted}, earned ${term.creditsEarned}`, { indent: 10 });
    }
    body().moveDown(1).fontSize(10).text(`Cumulative GPA ${t.cumulative.gpa?.toFixed(2) ?? "-"}   credits attempted ${t.cumulative.creditsAttempted}, earned ${t.cumulative.creditsEarned}`);
    body().moveDown(1).fontSize(8).text(meta.version === "formal" ? `Official copy, document no. ${meta.docNumber}.` : "For reference only. This copy is not an official document.", { align: "center" });
    if (meta.verify) {
      // 验真二维码和指纹：放在最后一页的底部；二维码用矢量方块画，放大缩小不糊
      const qr = QRCode.create(meta.verify.url, { errorCorrectionLevel: "M" });
      const n = qr.modules.size;
      const cell = 2.2;
      const side = n * cell;
      if (doc.y + side + 30 > doc.page.height - doc.page.margins.bottom) doc.addPage();
      const left = doc.page.margins.left;
      const top = doc.page.height - doc.page.margins.bottom - side - 6;
      doc.fillColor("#000000");
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) doc.rect(left + c * cell, top + r * cell, cell, cell).fill();
      body().fontSize(8);
      doc.text("Scan to verify this document online", left + side + 10, top + 6, { lineBreak: false });
      doc.text(text(meta.verify.url), left + side + 10, top + 20, { lineBreak: false });
      doc.text(`Fingerprint ${meta.verify.fingerprint}`, left + side + 10, top + 34, { lineBreak: false });
    }
    doc.end();
    return done;
  }
}

export const asNumber = (d: Prisma.Decimal | null | undefined) => (d == null ? null : Number(d));
