// "本人任教/就读的班级"：数据范围解析器用它把"班级"维度解析成班级 id。
import { Injectable } from "@nestjs/common";
import type { ClassMembershipProvider } from "../data-scope/data-scope.service";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

@Injectable()
export class ClassMembershipService implements ClassMembershipProvider {
  constructor(private readonly tenantDb: TenantPrismaService) {}

  async classIdsFor(personId: string): Promise<string[]> {
    const rows = await this.tenantDb.db.section.findMany({
      where: { OR: [{ instructors: { some: { personId } } }, { enrollments: { some: { studentPersonId: personId, status: { in: ["enrolled", "completed"] } } } }] },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
