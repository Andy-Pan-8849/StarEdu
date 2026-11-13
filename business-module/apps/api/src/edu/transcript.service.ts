// 成绩单：内容（课程、学期、学分、等级、绩点、学期与累计 GPA、退课 W）、编号与生成记录、PDF。
//   - 只统计已发布的最终成绩；退课（W）列出但不计 GPA；进行中的列出但不计 GPA。
//   - 重修：同一门课最新一次替代旧的，旧记录标"已重修，不计 GPA"，学分只算一次。
//   - 非正式版（学生自助下载，页脚"仅供参考"）和正式版（教务生成）；每份有唯一文档编号，生成记录入库。
//   - PDF 用 pdfkit。内置字体只含拉丁字符；要显示中文，把环境变量 TRANSCRIPT_FONT_PATH 指向一个支持中文的 TTF/OTF 字体（如 Noto Sans SC，OFL 许可）。
import { Injectable, NotFoundException } from "@nestjs/common";
import { existsSync } from "node:fs";
import PDFDocument from "pdfkit";
import { Prisma } from "../generated/prisma";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { requireTenant } from "../tenancy/request-scope";
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

const latinSafe = (text: string): string => [...text].map((c) => (c.charCodeAt(0) > 0x24f ? "?" : c)).join("");

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

  /** 登记一份成绩单：生成唯一文档编号（TR-年份-六位序号，撞号就重试）。 */
  async issue(personId: string, version: "informal" | "formal", generatedBy: string | null): Promise<{ id: string; docNumber: string; generatedAt: Date }> {
    const tenant = requireTenant("issue transcript");
    const year = new Date().getUTCFullYear();
    for (let attempt = 0; attempt < 8; attempt++) {
      const seq = (await this.db.transcriptIssue.count()) + 1 + attempt;
      const docNumber = `TR-${year}-${String(seq).padStart(6, "0")}`;
      try {
        const r = await this.db.transcriptIssue.create({ data: { tenantId: tenant.tenantId, studentPersonId: personId, docNumber, version, generatedBy } });
        return { id: r.id, docNumber, generatedAt: r.generatedAt };
      } catch (err) {
        if ((err as { code?: string }).code !== "P2002") throw err;
      }
    }
    throw new Error("Could not allocate a transcript number");
  }

  async pdf(t: Transcript, meta: { version: "informal" | "formal"; docNumber: string; generatedAt: Date; institution: string }): Promise<Buffer> {
    const font = process.env.TRANSCRIPT_FONT_PATH && existsSync(process.env.TRANSCRIPT_FONT_PATH) ? process.env.TRANSCRIPT_FONT_PATH : null;
    const text = (s: string) => (font ? s : latinSafe(s));
    const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Transcript ${meta.docNumber}` } });
    if (font) doc.registerFont("body", font);
    const body = () => doc.font(font ? "body" : "Helvetica").fontSize(9);
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
    doc.end();
    return done;
  }
}

export const asNumber = (d: Prisma.Decimal | null | undefined) => (d == null ? null : Number(d));
