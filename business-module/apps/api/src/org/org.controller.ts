// B1 的只读示例接口：校区、部门、岗位。用来证明租户隔离，同时是泄露扫描的第一批对象；
// 权限码和数据范围在 B2 加上，增删改在 B4。
import { Controller, Get, NotFoundException, Param, ParseUUIDPipe } from "@nestjs/common";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

@Controller("api")
export class OrgController {
  constructor(private readonly tenantDb: TenantPrismaService) {}

  @Get("campuses")
  campuses() {
    return this.tenantDb.db.campus.findMany({ orderBy: { code: "asc" } });
  }

  @Get("campuses/:id")
  async campus(@Param("id", ParseUUIDPipe) id: string) {
    const row = await this.tenantDb.db.campus.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  @Get("depts")
  depts() {
    return this.tenantDb.db.dept.findMany({ orderBy: { name: "asc" } });
  }

  @Get("depts/:id")
  async dept(@Param("id", ParseUUIDPipe) id: string) {
    const row = await this.tenantDb.db.dept.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  @Get("posts")
  posts() {
    return this.tenantDb.db.post.findMany({ orderBy: { code: "asc" } });
  }

  @Get("posts/:id")
  async post(@Param("id", ParseUUIDPipe) id: string) {
    const row = await this.tenantDb.db.post.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }
}
