// 字典的取值校验：某个字段只允许取字典里启用的条目（租户可以在"字典"里增减条目）。
import { BadRequestException, Injectable } from "@nestjs/common";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

@Injectable()
export class DictService {
  constructor(private readonly tenantDb: TenantPrismaService) {}

  /** 值必须是该字典里启用的条目，否则 400，并告诉调用方现在允许哪些值。 */
  async assertValue(code: string, value: string, field: string): Promise<void> {
    const db = this.tenantDb.db;
    const type = await db.dictType.findFirst({ where: { code, status: true } });
    const items = type ? await db.dictItem.findMany({ where: { typeId: type.id, status: true }, select: { value: true } }) : [];
    if (!items.some((i) => i.value === value)) throw new BadRequestException(`${field} must be one of: ${items.map((i) => i.value).join(", ") || "(the dictionary is empty)"}`);
  }
}
