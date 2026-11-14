// 内部权限接口：AI 模块用来问"这个令牌的主人是谁、有什么角色和权限、每个权限下能看哪些数据"。
//   - 身份来自令牌（和所有接口一样由守卫验证）；调用方还必须带服务密钥（INTERNAL_API_KEY，常数时间比较）。
//     没配置密钥就整个接口关闭（返回 503），不会"忘了配就对外开放"。
//   - 回答里的数据范围就是业务模块自己的数据范围解析器的结果，AI 模块不再自己判断规则。
//   - 按权限版本号缓存：回答带 ETag（权限版本 + 账号）；调用方带 If-None-Match 且没变就返回 304，不再重算和传输。
import { Controller, ForbiddenException, Get, Headers, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Res, ServiceUnavailableException, UseGuards, type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import { PERMS } from "@staredu/shared";
import { AnyAuthenticated } from "../auth/decorators";
import { Public } from "../auth/public.decorator";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth } from "../common/http";
import { LibraryAccess } from "../library/library-access.service";
import { ObjectStoreService, assertTenantKey } from "../storage/object-store.service";
import { DataScopeService } from "../data-scope/data-scope.service";
import { currentScope } from "../tenancy/request-scope";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

/** AI 视图用到的权限字符：每一个都要回答它的数据范围。 */
export const AI_VIEW_PERMISSIONS = [
  PERMS.hrStudentList, PERMS.eduSectionList, PERMS.eduEnrollmentList, PERMS.eduAssignmentList, PERMS.eduSubmissionList, PERMS.eduGradeList,
  PERMS.portalEnrollList, PERMS.portalAssignmentList, PERMS.portalGradeList,
] as const;

const digest = (s: string) => createHash("sha256").update(s).digest();

@Injectable()
export class InternalKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.INTERNAL_API_KEY;
    if (!expected) throw new ServiceUnavailableException("The internal API is not configured");
    const given = context.switchToHttp().getRequest().headers["x-internal-key"];
    if (typeof given !== "string" || !timingSafeEqual(digest(given), digest(expected))) throw new ForbiddenException("This interface is for services only");
    return true;
  }
}

@Controller("api/internal")
export class InternalAuthzController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly scopes: DataScopeService,
    private readonly library: LibraryAccess,
  ) {}

  /**
   * AI 知识库问"这个用户能读哪些文件夹"。规则就是文档库自己的规则（操作权限 ∧ 文件夹授权，含继承、到期、机密、仅在线查看），
   * 每次现算、不缓存：授权一改、到期一到，AI 下一次检索就看不到。用户没有任何"文档库/资料库"查看权限就是空列表。
   */
  @Post("library-access")
  @HttpCode(200)
  @AnyAuthenticated()
  @UseGuards(InternalKeyGuard)
  async libraryAccess(@Auth() auth: AuthContext) {
    const mayRead = auth.authz.perms.includes(PERMS.docLibraryList) || auth.authz.perms.includes(PERMS.portalLibraryList);
    return { folderIds: mayRead ? await this.library.aiReadableFolderIds(auth) : [] };
  }

  @Post("authz")
  @HttpCode(200)
  @AnyAuthenticated()
  @UseGuards(InternalKeyGuard)
  async authz(@Auth() auth: AuthContext, @Headers("if-none-match") ifNoneMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    const etag = `"${auth.authz.version}:${auth.accountId}"`;
    res.setHeader("etag", etag);
    if (ifNoneMatch === etag) {
      res.status(304);
      return;
    }
    const db = this.tenantDb.db;
    const scope = currentScope();
    const [account, person] = await Promise.all([
      db.account.findUnique({ where: { id: auth.accountId }, select: { username: true, isBuiltinAdmin: true } }),
      auth.authz.personId ? db.person.findUnique({ where: { id: auth.authz.personId }, include: { depts: true } }) : Promise.resolve(null),
    ]);
    const scopes: Record<string, unknown> = {};
    for (const perm of AI_VIEW_PERMISSIONS) {
      const s = await this.scopes.resolve(auth.tenantId, auth.authz, perm);
      scopes[perm] = { all: s.all, deptIds: s.deptIds, classIds: s.classIds, selfPersonId: s.selfPersonId };
    }
    // 主要部门所在校区的代码（给 AI 知识库的"校区范围"用）
    let campusCode: string | null = null;
    const primary = person?.depts.find((d) => d.isPrimary) ?? person?.depts[0];
    if (primary) {
      const dept = await db.dept.findUnique({ where: { id: primary.deptId } });
      const campus = dept ? (await db.campus.findMany({ where: { deptId: { in: dept.ancestors } } }))[0] : null;
      campusCode = campus?.code ?? null;
    }
    return {
      tenantId: auth.tenantId,
      tenantCode: scope?.kind === "tenant" ? scope.code : "",
      accountId: auth.accountId,
      personId: auth.authz.personId,
      username: account?.username ?? auth.authz.username,
      name: person?.fullName ?? null,
      kind: account?.isBuiltinAdmin ? "admin" : person?.type === "student" ? "student" : person?.type === "staff" ? "staff" : "other",
      campusCode,
      roles: auth.authz.roles.map((r) => r.code),
      permissions: auth.authz.perms,
      scopes,
      permVersion: auth.authz.version,
    };
  }
}

/**
 * 知识库入库用的内容接口：AI 模块收到"大纲或课件变了"的事件（只带课程 id）后，来取课程大纲和各班已发布的课件清单。
 * 只认服务密钥（没有用户令牌——这是后台任务）；租户由主机名确定。课件只有标题和外链，没有文件，所以入库的是"清单"。
 */
@Controller("api/internal/kb")
@Public()
@UseGuards(InternalKeyGuard)
export class InternalKbController {
  constructor(private readonly tenantDb: TenantPrismaService, private readonly store: ObjectStoreService) {}

  /** 文档库文件的元数据（删除了也会返回，带 deleted，让 AI 把对应知识库文档转成草稿）。 */
  @Get("files/:fileId")
  async file(@Param("fileId", ParseUUIDPipe) fileId: string) {
    const db = this.tenantDb.db;
    const f = await db.docFile.findFirst({ where: { id: fileId } });
    if (!f) throw new NotFoundException();
    const folder = await db.docFolder.findFirst({ where: { id: f.folderId } });
    return { fileId: f.id, folderId: f.folderId, name: f.name, contentType: f.contentType, size: f.size, version: f.version, deleted: f.deletedAt !== null, classification: folder?.classification ?? "internal" };
  }

  /** 文件内容（当前版本）。 */
  @Get("files/:fileId/content")
  async fileContent(@Param("fileId", ParseUUIDPipe) fileId: string, @Res() res: Response) {
    const f = await this.tenantDb.db.docFile.findFirst({ where: { id: fileId, deletedAt: null } });
    if (!f) throw new NotFoundException();
    assertTenantKey(f.tenantId, f.storageKey);
    res.setHeader("content-type", "application/octet-stream");
    res.send(await this.store.get(f.storageKey));
  }

  @Get("courses/:courseId")
  async course(@Param("courseId", ParseUUIDPipe) courseId: string) {
    const db = this.tenantDb.db;
    const course = await db.course.findFirst({ where: { id: courseId } });
    if (!course) throw new NotFoundException();
    const sections = await db.section.findMany({ where: { courseId, status: { in: ["open", "in_progress", "ended"] } }, include: { term: true }, orderBy: { name: "asc" } });
    const materials = await db.sectionMaterial.findMany({ where: { sectionId: { in: sections.map((s) => s.id) }, published: true }, orderBy: [{ sort: "asc" }, { createdAt: "asc" }] });
    return {
      courseId: course.id, code: course.code, name: course.name, credits: Number(course.credits), status: course.status, syllabus: course.syllabus ?? "",
      sections: sections.map((s) => ({ id: s.id, name: s.name, term: s.term.name, materials: materials.filter((m) => m.sectionId === s.id).map((m) => ({ title: m.title, category: m.category, url: m.url })) })),
    };
  }
}
