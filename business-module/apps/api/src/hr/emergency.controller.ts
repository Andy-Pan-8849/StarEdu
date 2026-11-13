// 紧急联系人：挂在自然人上，员工和学员共用，一个人可有多个并有优先顺序。
// 敏感信息：需要 hr:emergency:view/edit，且目标人员在"非基础"范围内（内置租户管理员因此永远看不到）；
// 查看和修改都写审计日志（修改还会进操作日志）。列表页不展示，只在详情里。
import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { requireTenant } from "../tenancy/request-scope";
import { HrAccess } from "./hr-access.service";

const contactSchema = z.object({
  priority: z.number().int().min(1).max(20).optional(),
  name: z.string().trim().min(1).max(200),
  relationship: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(3).max(50),
  phone2: z.string().trim().max(50).nullable().optional(),
  email: z.string().email().max(200).nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  isGuardian: z.boolean().optional(),
  note: z.string().max(1000).nullable().optional(),
});

@Controller("api/persons/:personId/emergency-contacts")
export class EmergencyController {
  constructor(
    private readonly hr: HrAccess,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.hr.tenantDb.db;
  }

  /** 权限 + 范围：目标人员必须在操作者的"非基础"范围里，否则 404（不透露是否存在）。 */
  private async guard(auth: AuthContext, personId: string, perm: string) {
    if (!auth.authz.perms.includes(perm)) throw new ForbiddenException("Missing permission");
    const scope = await this.hr.scope(auth, perm);
    if (!(await this.hr.inFullScope(scope, personId))) throw new NotFoundException();
  }

  @Get()
  @RequirePermissions(PERMS.hrEmergencyView)
  async list(@Auth() auth: AuthContext, @Param("personId", ParseUUIDPipe) personId: string) {
    await this.guard(auth, personId, PERMS.hrEmergencyView);
    const rows = await this.db.emergencyContact.findMany({ where: { personId }, orderBy: [{ priority: "asc" }, { createdAt: "asc" }] });
    await this.audit.record(auth.accountId, "emergency.view", "person", personId, { count: rows.length }); // 查看也留痕
    return rows;
  }

  @Post()
  @RequirePermissions(PERMS.hrEmergencyEdit)
  async create(@Auth() auth: AuthContext, @Param("personId", ParseUUIDPipe) personId: string, @Body() body: unknown) {
    const input = parse(contactSchema, body);
    await this.guard(auth, personId, PERMS.hrEmergencyEdit);
    const tenant = requireTenant("create emergency contact");
    const count = await this.db.emergencyContact.count({ where: { personId } });
    const row = await this.db.emergencyContact.create({ data: { tenantId: tenant.tenantId, personId, ...input, priority: input.priority ?? count + 1 } });
    await this.audit.record(auth.accountId, "emergency.create", "person", personId, { contactId: row.id });
    return row;
  }

  @Put(":id")
  @RequirePermissions(PERMS.hrEmergencyEdit)
  async update(@Auth() auth: AuthContext, @Param("personId", ParseUUIDPipe) personId: string, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(contactSchema, body);
    await this.guard(auth, personId, PERMS.hrEmergencyEdit);
    if (!(await this.db.emergencyContact.findFirst({ where: { id, personId } }))) throw new NotFoundException();
    const row = await this.db.emergencyContact.update({ where: { id }, data: input });
    await this.audit.record(auth.accountId, "emergency.update", "person", personId, { contactId: id });
    return row;
  }

  @Delete(":id")
  @RequirePermissions(PERMS.hrEmergencyEdit)
  async remove(@Auth() auth: AuthContext, @Param("personId", ParseUUIDPipe) personId: string, @Param("id", ParseUUIDPipe) id: string) {
    await this.guard(auth, personId, PERMS.hrEmergencyEdit);
    if (!(await this.db.emergencyContact.findFirst({ where: { id, personId } }))) throw new NotFoundException();
    await this.db.emergencyContact.deleteMany({ where: { id, personId } });
    await this.audit.record(auth.accountId, "emergency.delete", "person", personId, { contactId: id });
    return { id };
  }
}
