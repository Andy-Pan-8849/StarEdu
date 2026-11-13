// 人员（自然人）：目录级的基础信息 + 敏感信息分层。
//   - 列表、详情、修改都走数据范围解析器；范围外一律 404（不区分"不存在"和"范围外"）；
//   - 敏感信息（出生日期、性别、证件号、个人电话、住址）：要 hr:person:sensitive，且目标在"非基础"范围内——
//     内置租户管理员（范围只有"教职员工基础信息"）因此永远看不到，也改不了；
//   - 工作邮箱、证件号在租户内唯一（重复 409）。
import { Body, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Patch } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { withScope } from "../data-scope/scope-filter";
import { parseDay } from "./effective";
import { basicPerson, HrAccess, PERSON_SCOPE, sensitivePerson } from "./hr-access.service";

export { PERSON_SCOPE };

const patchSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200).optional(),
    workEmail: z.string().email().max(200).nullable().optional(),
    birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    gender: z.string().max(30).nullable().optional(),
    idNumber: z.string().trim().max(50).nullable().optional(),
    phone: z.string().trim().max(50).nullable().optional(),
    address: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
const SENSITIVE_KEYS = ["birthDate", "gender", "idNumber", "phone", "address"] as const;

@Controller("api/persons")
export class PersonsController {
  constructor(private readonly hr: HrAccess) {}

  private get db() {
    return this.hr.tenantDb.db;
  }

  @Get()
  @RequirePermissions(PERMS.hrPersonList)
  async list(@Auth() auth: AuthContext) {
    const scope = await this.hr.scope(auth, PERMS.hrPersonList);
    const rows = await this.db.person.findMany({ where: withScope(undefined, scope, PERSON_SCOPE), include: { depts: true }, orderBy: { fullName: "asc" } });
    return rows.map((r) => ({ ...basicPerson(r), depts: r.depts }));
  }

  @Get(":id")
  @RequirePermissions(PERMS.hrPersonList)
  async get(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string) {
    const scope = await this.hr.scope(auth, PERMS.hrPersonList);
    const row = await this.db.person.findFirst({ where: withScope({ id }, scope, PERSON_SCOPE), include: { depts: true } });
    if (!row) throw new NotFoundException();
    const full = auth.authz.perms.includes(PERMS.hrPersonSensitive) && (await this.hr.inFullScope(await this.hr.scope(auth, PERMS.hrPersonSensitive), id));
    return { ...basicPerson(row), depts: row.depts, ...(full ? { sensitive: sensitivePerson(row) } : {}) };
  }

  @Patch(":id")
  @RequirePermissions(PERMS.hrPersonEdit)
  async update(@Auth() auth: AuthContext, @Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = parse(patchSchema, body);
    const scope = await this.hr.scope(auth, PERMS.hrPersonEdit);
    const target = await this.db.person.findFirst({ where: withScope({ id }, scope, PERSON_SCOPE) });
    if (!target) throw new NotFoundException();
    const touchesSensitive = SENSITIVE_KEYS.some((k) => input[k] !== undefined);
    if (touchesSensitive) {
      const allowed = auth.authz.perms.includes(PERMS.hrPersonSensitive) && (await this.hr.inFullScope(await this.hr.scope(auth, PERMS.hrPersonSensitive), id));
      if (!allowed) throw new ForbiddenException("You may not change sensitive information of this person");
    }
    const { birthDate, ...rest } = input;
    try {
      const row = await this.db.person.update({ where: { id }, data: { ...rest, ...(birthDate !== undefined ? { birthDate: birthDate === null ? null : parseDay(birthDate) } : {}), updatedBy: auth.accountId } });
      return basicPerson(row);
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw new ConflictException("E-mail or ID number already belongs to another person");
      throw err;
    }
  }
}
