// 校区管理。校区 = 部门树上的一个根节点 + 校区记录：
//   - 新建校区自动建部门根节点并绑定；改名两边同步；校区代码建好后不改；
//   - 校区从不删除，只能关闭：状态 正常 ⇄ 停止新增 → 已关闭（可重新开放）；总部校区不能关闭；
//   - 关闭前检查三类（在读学生、有效任职的教职员工、进行中的班级），必须清零；
//     班级要等教学模块（B6），这里先报告"尚未提供"且按 0 计；
//   - 关闭是危险操作：单独权限、要输入校区名称确认、写操作日志；关闭后部门子树自动停用，重新开放时恢复。
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { AuthzService } from "../rbac/authz.service";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

const createSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_-]{1,19}$/, "uppercase letters, digits, hyphen or underscore; 2-20 characters"),
  name: z.string().trim().min(1).max(200),
  shortName: z.string().trim().max(100).optional(),
  address: z.string().trim().max(500).optional(),
  timezone: z.string().max(60).optional(),
});
const patchSchema = z.object({ name: z.string().trim().min(1).max(200).optional(), shortName: z.string().trim().max(100).nullable().optional(), address: z.string().trim().max(500).nullable().optional(), timezone: z.string().max(60).optional() }).strict();
const statusSchema = z.object({ status: z.enum(["normal", "stop_new", "closed"]), confirmName: z.string().optional() });

@Controller("api/campuses")
export class CampusesController {
  constructor(
    private readonly tenantDb: TenantPrismaService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions(PERMS.campusList)
  list() {
    return this.tenantDb.db.campus.findMany({ orderBy: { code: "asc" } });
  }

  @Get(":id")
  @RequirePermissions(PERMS.campusList)
  async get(@Param("id", ParseUUIDPipe) id: string) {
    const row = await this.tenantDb.db.campus.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  /** 关闭前检查：三类数量和清单（各最多 50 条）。 */
  @Get(":id/closure-check")
  @RequirePermissions(PERMS.campusList)
  async closureCheck(@Param("id", ParseUUIDPipe) id: string) {
    const campus = await this.campus(id);
    return this.check(campus.deptId);
  }

  private async campus(id: string) {
    const row = await this.tenantDb.db.campus.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  private async check(deptId: string) {
    const db = this.tenantDb.db;
    const subtree = (await db.dept.findMany({ where: { ancestors: { has: deptId } }, select: { id: true } })).map((d) => d.id);
    const links = subtree.length ? await db.personDept.findMany({ where: { deptId: { in: subtree } } }) : [];
    const people = links.length ? await db.person.findMany({ where: { id: { in: [...new Set(links.map((l) => l.personId))] } }, select: { id: true, fullName: true, type: true } }) : [];
    const students = people.filter((p) => p.type === "student");
    const staff = people.filter((p) => p.type === "staff");
    return {
      students: { count: students.length, items: students.slice(0, 50) },
      staffAssignments: { count: staff.length, items: staff.slice(0, 50) },
      // 班级在教学模块（B6）里；现在没有班级，按 0 计
      classes: { count: 0, items: [], implemented: false },
      canClose: students.length === 0 && staff.length === 0,
    };
  }

  @Post()
  @RequirePermissions(PERMS.campusAdd)
  async create(@Auth() auth: AuthContext, @Body() body: unknown) {
    const input = parse(createSchema, body);
    try {
      const campus = await this.tenantDb.transaction(async (tx) => {
        const dept = await tx.dept.create({ data: { tenantId: auth.tenantId, name: input.name, createdBy: auth.accountId } });
        return tx.campus.create({
          data: { tenantId: auth.tenantId, deptId: dept.id, code: input.code, name: input.name, shortName: input.shortName ?? null, address: input.address ?? null, timezone: input.timezone ?? "UTC", type: "campus", createdBy: auth.accountId },
        });
      });
      await this.audit.record(auth.accountId, "campus.create", "campus", campus.id, { code: campus.code });
      return campus;
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("Campus code already exists");
      throw err;
    }
  }

  @Patch(":id")
  @RequirePermissions(PERMS.campusEdit)
  async update(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(patchSchema, body);
    const campus = await this.campus(id);
    const row = await this.tenantDb.transaction(async (tx) => {
      const updated = await tx.campus.update({ where: { id }, data: { ...input, updatedBy: auth.accountId } });
      if (input.name && input.name !== campus.name) await tx.dept.update({ where: { id: campus.deptId }, data: { name: input.name, updatedBy: auth.accountId } }); // 两边同步
      return updated;
    });
    await this.audit.record(auth.accountId, "campus.update", "campus", id, input);
    return row;
  }

  @Post(":id/status")
  @RequirePermissions(PERMS.campusClose)
  async setStatus(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { status, confirmName } = parse(statusSchema, body);
    const campus = await this.campus(id);
    if (campus.type === "hq" && status !== "normal") throw new ForbiddenException("The headquarters campus cannot be closed");
    if (campus.status === status) throw new ConflictException(`The campus is already ${status}`);
    // 允许：正常 ⇄ 停止新增；停止新增 → 已关闭；已关闭 → 正常（重新开放）
    const allowed: Record<string, string[]> = { normal: ["stop_new"], stop_new: ["normal", "closed"], closed: ["normal"] };
    if (!allowed[campus.status].includes(status)) throw new ConflictException(`Cannot go from ${campus.status} to ${status}`);
    if (status === "closed") {
      if (confirmName !== campus.name) throw new BadRequestException("Type the campus name to confirm closing it");
      const check = await this.check(campus.deptId);
      if (!check.canClose) throw new ConflictException({ message: "The campus still has students or staff assignments", check });
    }
    await this.tenantDb.transaction(async (tx) => {
      await tx.campus.update({ where: { id }, data: { status, updatedBy: auth.accountId } });
      // 关闭：部门节点及子树自动停用；重新开放：恢复启用（原来结束的任职不自动恢复）
      if (status === "closed" || campus.status === "closed") {
        const ids = (await tx.dept.findMany({ where: { ancestors: { has: campus.deptId } }, select: { id: true } })).map((d) => d.id);
        await tx.dept.updateMany({ where: { id: { in: ids } }, data: { status: status !== "closed" } });
      }
    });
    await this.authz.bump(auth.tenantId);
    await this.audit.record(auth.accountId, "campus.status", "campus", id, { from: campus.status, to: status });
    return { id, status };
  }
}
