// 学生门户：我的成绩、学分进度和成绩单下载。
//   毕业、结业、退学的学生是"成绩单模式"：仍能看自己的成绩、下载非正式版成绩单（不能选课、提交）。
//   只有发布过的最终成绩可见；非正式版页脚写"仅供参考"，每份有编号。
import { resolveVersion } from "@staredu/shared";
import { Controller, ForbiddenException, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { PERMS } from "@staredu/shared";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth } from "../common/http";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";
import { TranscriptService } from "./transcript.service";

@Controller("api/portal")
export class PortalGradesController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly transcripts: TranscriptService,
  ) {}

  private async me(auth: AuthContext): Promise<string> {
    const personId = auth.authz.personId;
    const profile = personId ? await this.tenantDb.db.studentProfile.findFirst({ where: { personId } }) : null;
    if (!personId || !profile) throw new ForbiddenException("This area is for students");
    return personId;
  }

  @Get("grades")
  @RequirePermissions(PERMS.portalGradeList)
  async grades(@Auth() auth: AuthContext) {
    const transcript = await this.transcripts.build(await this.me(auth));
    const major = await this.tenantDb.db.studentMajor.findFirst({ where: { personId: transcript.student.personId, kind: "primary", active: true } });
    const version = major ? resolveVersion(await this.tenantDb.db.majorVersion.findMany({ where: { majorId: major.majorId } }), major.entryYear) : null;
    const required = major ? Number(version?.totalCredits ?? 0) : null;
    return { ...transcript, progress: { creditsEarned: transcript.cumulative.creditsEarned, creditsRequired: required, trend: transcript.terms.map((t) => ({ term: t.name, gpa: t.gpa })) } };
  }

  @Get("transcript.pdf")
  @RequirePermissions(PERMS.portalTranscriptDownload)
  async download(@Auth() auth: AuthContext, @Res() res: Response) {
    const personId = await this.me(auth);
    const t = await this.transcripts.build(personId);
    const issue = await this.transcripts.issue(personId, "informal", auth.accountId);
    const tenant = await this.tenantDb.db.tenant.findUnique({ where: { id: auth.tenantId } });
    const pdf = await this.transcripts.pdf(t, { version: "informal", docNumber: issue.docNumber, generatedAt: issue.generatedAt, institution: tenant?.name ?? "Institution" });
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `attachment; filename="${issue.docNumber}.pdf"`);
    res.send(pdf);
  }
}
