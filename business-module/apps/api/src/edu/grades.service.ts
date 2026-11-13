// 成绩的数据库一侧：成绩册（学生 × 作业）、总评、最终成绩的草稿/发布、结课后的更正。
//   - 单次成绩：已发布的提交的最终得分；没有提交的作业用手工录入；缺交按 0 分。
//   - 只有"已发布、所属分组权重大于 0"的作业计入总评。
//   - 发布最终成绩时同时写 enrollment.passed（先修课校验和培养方案只认它）。
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { Prisma } from "../generated/prisma";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { requireTenant } from "../tenancy/request-scope";
import { DEFAULT_SCALE, finalTotal, gradeFor, policyProblems, type GroupInput, type ScaleItem } from "./grade-calc";
import { OutboxService } from "./outbox.service";

export interface GradebookStudent {
  enrollmentId: string;
  personId: string;
  fullName: string | null;
  studentNo: string | null;
  enrollmentStatus: string;
  /** 每次作业：得分（没有为 null）和来源 */
  cells: Record<string, { points: number | null; state: "scored" | "manual" | "unpublished" | "missing" }>;
  groupRates: Array<{ groupId: string; rate: number | null }>;
  total: number | null;
  grade: string | null;
  final: { total: number; grade: string; gradePoints: number; passed: boolean; published: boolean } | null;
}

@Injectable()
export class GradesService {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private get db() {
    return this.tenantDb.db;
  }

  /** 租户的等级表；没有设置过就用默认表。 */
  async scale(): Promise<ScaleItem[]> {
    const rows = await this.db.gradingScaleItem.findMany();
    if (!rows.length) return DEFAULT_SCALE;
    return rows.map((r) => ({ grade: r.grade, minPercent: Number(r.minPercent), points: Number(r.points), passing: r.passing })).sort((a, b) => b.minPercent - a.minPercent);
  }

  /** 成绩册：政策、每个学生每次作业的得分、分组得分率、总评（算出来的）和已存的最终成绩。 */
  async gradebook(sectionId: string) {
    const [groups, assignments, enrollments] = await Promise.all([
      this.db.assignmentGroup.findMany({ where: { sectionId }, orderBy: [{ sort: "asc" }, { name: "asc" }] }),
      this.db.assignment.findMany({ where: { sectionId, published: true }, orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }] }),
      this.db.enrollment.findMany({ where: { sectionId, status: { in: ["enrolled", "completed"] } }, orderBy: { enrolledAt: "asc" } }),
    ]);
    const personIds = enrollments.map((e) => e.studentPersonId);
    const aIds = assignments.map((a) => a.id);
    const [people, profiles, subs, manual, finals, scale] = await Promise.all([
      this.db.person.findMany({ where: { id: { in: personIds } }, select: { id: true, fullName: true } }),
      this.db.studentProfile.findMany({ where: { personId: { in: personIds } } }),
      this.db.submission.findMany({ where: { assignmentId: { in: aIds } } }),
      this.db.manualGrade.findMany({ where: { assignmentId: { in: aIds } } }),
      this.db.finalGrade.findMany({ where: { enrollmentId: { in: enrollments.map((e) => e.id) } } }),
      this.scale(),
    ]);
    const name = new Map(people.map((p) => [p.id, p.fullName]));
    const no = new Map(profiles.map((p) => [p.personId, p.studentNo]));
    const sub = new Map(subs.map((s) => [`${s.assignmentId}:${s.studentPersonId}`, s]));
    const man = new Map(manual.map((m) => [`${m.assignmentId}:${m.studentPersonId}`, m]));
    const fin = new Map(finals.map((f) => [f.enrollmentId, f]));
    const counted = assignments.filter((a) => a.groupId && Number(groups.find((g) => g.id === a.groupId)?.weight ?? 0) > 0);
    const weighted = groups.filter((g) => Number(g.weight) > 0);

    const structure: GroupInput[] = weighted.map((g) => ({ name: g.name, weight: Number(g.weight), items: counted.filter((a) => a.groupId === g.id).map((a) => ({ earned: 0, max: a.maxScore })) }));
    const problems = policyProblems(groups.length ? structure : []);
    if (groups.length === 0) problems.push("Create assignment groups and give them weights first");
    const pending = subs.filter((s) => s.status !== "published" && counted.some((a) => a.id === s.assignmentId)).length;

    const students: GradebookStudent[] = enrollments.map((e) => {
      const cells: GradebookStudent["cells"] = {};
      for (const a of assignments) {
        const s = sub.get(`${a.id}:${e.studentPersonId}`);
        const m = man.get(`${a.id}:${e.studentPersonId}`);
        if (s?.status === "published") cells[a.id] = { points: Number(s.finalScore ?? 0), state: "scored" };
        else if (m) cells[a.id] = { points: Number(m.points), state: "manual" };
        else if (s) cells[a.id] = { points: null, state: "unpublished" };
        else cells[a.id] = { points: null, state: "missing" };
      }
      const inputs: GroupInput[] = weighted.map((g) => ({ name: g.name, weight: Number(g.weight), items: counted.filter((a) => a.groupId === g.id).map((a) => ({ earned: cells[a.id].points ?? 0, max: a.maxScore })) }));
      const groupRates = weighted.map((g, i) => {
        const max = inputs[i].items.reduce((x, it) => x.plus(it.max), new Prisma.Decimal(0));
        const got = inputs[i].items.reduce((x, it) => x.plus(it.earned), new Prisma.Decimal(0));
        return { groupId: g.id, rate: max.gt(0) ? got.div(max).toDecimalPlaces(4).toNumber() : null };
      });
      const ok = problems.length === 0;
      const total = ok ? finalTotal(inputs) : null;
      const f = fin.get(e.id);
      return {
        enrollmentId: e.id, personId: e.studentPersonId, fullName: name.get(e.studentPersonId) ?? null, studentNo: no.get(e.studentPersonId) ?? null, enrollmentStatus: e.status,
        cells, groupRates, total: total ? total.toNumber() : null, grade: total ? gradeFor(scale, total).grade : null,
        final: f ? { total: Number(f.total), grade: f.grade, gradePoints: Number(f.gradePoints), passed: f.passed, published: !!f.publishedAt } : null,
      };
    });
    return {
      groups: groups.map((g) => ({ id: g.id, name: g.name, weight: Number(g.weight), assignmentIds: assignments.filter((a) => a.groupId === g.id).map((a) => a.id) })),
      assignments: assignments.map((a) => ({ id: a.id, title: a.title, groupId: a.groupId, maxScore: Number(a.maxScore), manualOnly: a.manualOnly, counted: counted.some((c) => c.id === a.id), dueDate: a.dueDate })),
      problems, pendingSubmissions: pending, students,
    };
  }

  /** 算总评并存成最终成绩。已发布的成绩被重算且结果有变化时，记改前改后。 */
  async calculate(sectionId: string, actorAccountId: string | null, opts: { kind: "calculate" | "amend_recalc"; reason?: string }): Promise<{ calculated: number; changed: number }> {
    const book = await this.gradebook(sectionId);
    if (book.problems.length) throw new ConflictException({ code: "POLICY", message: "The grade policy is not ready", problems: book.problems });
    if (book.pendingSubmissions) throw new ConflictException({ code: "PENDING_SUBMISSIONS", message: `${book.pendingSubmissions} submissions are not scored and published yet` });
    const scale = await this.scale();
    const tenant = requireTenant("calculate grades");
    let changed = 0;
    await this.tenantDb.transaction(async (tx) => {
      for (const s of book.students) {
        if (s.total === null) continue;
        const g = gradeFor(scale, s.total);
        const data = { total: new Prisma.Decimal(s.total), grade: g.grade, gradePoints: new Prisma.Decimal(g.points), passed: g.passing, breakdown: s.groupRates as never, computedBy: actorAccountId, computedAt: new Date() };
        const old = await tx.finalGrade.findUnique({ where: { enrollmentId: s.enrollmentId } });
        if (!old) {
          await tx.finalGrade.create({ data: { tenantId: tenant.tenantId, enrollmentId: s.enrollmentId, ...data } });
        } else {
          const differs = Number(old.total) !== s.total || old.grade !== g.grade;
          await tx.finalGrade.update({ where: { id: old.id }, data });
          if (old.publishedAt) {
            await tx.enrollment.update({ where: { id: s.enrollmentId }, data: { passed: g.passing } });
            if (differs) {
              changed++;
              await tx.gradeChange.create({ data: { tenantId: tenant.tenantId, enrollmentId: s.enrollmentId, kind: opts.kind, before: { total: Number(old.total), grade: old.grade, passed: old.passed }, after: { total: s.total, grade: g.grade, passed: g.passing }, reason: opts.reason ?? null, changedBy: actorAccountId } });
            }
          }
        }
      }
    });
    await this.audit.record(actorAccountId, `grades.${opts.kind}`, "section", sectionId, { students: book.students.length, changed, reason: opts.reason });
    return { calculated: book.students.filter((s) => s.total !== null).length, changed };
  }

  /** 发布最终成绩：每个学生都要有；同时写"是否通过"。 */
  async publish(sectionId: string, actorAccountId: string | null): Promise<{ published: number }> {
    const enrollments = await this.db.enrollment.findMany({ where: { sectionId, status: { in: ["enrolled", "completed"] } } });
    const finals = await this.db.finalGrade.findMany({ where: { enrollmentId: { in: enrollments.map((e) => e.id) } } });
    const have = new Set(finals.map((f) => f.enrollmentId));
    const missing = enrollments.filter((e) => !have.has(e.id)).length;
    if (missing) throw new ConflictException({ code: "NOT_CALCULATED", message: `${missing} students have no final grade yet; calculate first` });
    const tenant = requireTenant("publish grades");
    const fresh = finals.filter((f) => !f.publishedAt);
    await this.tenantDb.transaction(async (tx) => {
      for (const f of fresh) {
        await tx.finalGrade.update({ where: { id: f.id }, data: { publishedAt: new Date() } });
        await tx.enrollment.update({ where: { id: f.enrollmentId }, data: { passed: f.passed } });
        await tx.outboxEvent.create({ data: { tenantId: tenant.tenantId, type: "final_grade.published", payload: { sectionId, enrollmentId: f.enrollmentId } } });
      }
    });
    await this.audit.record(actorAccountId, "grades.publish", "section", sectionId, { published: fresh.length });
    return { published: fresh.length };
  }

  /** 更正一个学生的最终成绩（结课后教务用）：直接给出新的总评，等级和是否通过按等级表重算；改前改后、原因都记下来。 */
  async amend(sectionId: string, enrollmentId: string, total: number, reason: string, actorAccountId: string | null) {
    const e = await this.db.enrollment.findFirst({ where: { id: enrollmentId, sectionId } });
    if (!e) throw new NotFoundException();
    const old = await this.db.finalGrade.findUnique({ where: { enrollmentId } });
    if (!old) throw new ConflictException("This student has no final grade to amend; calculate first");
    const scale = await this.scale();
    const g = gradeFor(scale, total);
    const tenant = requireTenant("amend grade");
    await this.tenantDb.transaction(async (tx) => {
      await tx.finalGrade.update({ where: { id: old.id }, data: { total: new Prisma.Decimal(total), grade: g.grade, gradePoints: new Prisma.Decimal(g.points), passed: g.passing } });
      if (old.publishedAt) await tx.enrollment.update({ where: { id: enrollmentId }, data: { passed: g.passing } });
      await tx.gradeChange.create({ data: { tenantId: tenant.tenantId, enrollmentId, kind: "amend", before: { total: Number(old.total), grade: old.grade, passed: old.passed }, after: { total, grade: g.grade, passed: g.passing }, reason, changedBy: actorAccountId } });
    });
    await this.audit.record(actorAccountId, "grades.amend", "section", sectionId, { enrollmentId, from: Number(old.total), to: total, reason });
    return { enrollmentId, total, grade: g.grade, passed: g.passing };
  }
}
