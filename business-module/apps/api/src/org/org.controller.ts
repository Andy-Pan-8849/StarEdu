// B1 的只读示例接口：校区、部门、岗位。用来证明租户隔离，同时是泄露扫描的第一批对象；
// B2 加上权限码（系统管理类对象，只按权限字符控制，不做行级数据范围）；增删改在 B4。
import { Controller, Get, NotFoundException, Param, ParseUUIDPipe } from "@nestjs/common";
import { PERMS } from "@staredu/shared";
import { RequirePermissions } from "../auth/decorators";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

@Controller("api")
export class OrgController {
  constructor(private readonly tenantDb: TenantPrismaService) {}

  @Get("campuses")
  @RequirePermissions(PERMS.campusList)
  campuses() {
    return this.tenantDb.db.campus.findMany({ orderBy: { code: "asc" } });
  }

  @Get("campuses/:id")
  @RequirePermissions(PERMS.campusList)
  async campus(@Param("id", ParseUUIDPipe) id: string) {
    const row = await this.tenantDb.db.campus.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  @Get("depts")
  @RequirePermissions(PERMS.deptList)
  depts() {
    return this.tenantDb.db.dept.findMany({ orderBy: { name: "asc" } });
  }

  @Get("depts/:id")
  @RequirePermissions(PERMS.deptList)
  async dept(@Param("id", ParseUUIDPipe) id: string) {
    const row = await this.tenantDb.db.dept.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }

  @Get("posts")
  @RequirePermissions(PERMS.postList)
  posts() {
    return this.tenantDb.db.post.findMany({ orderBy: { code: "asc" } });
  }

  @Get("posts/:id")
  @RequirePermissions(PERMS.postList)
  async post(@Param("id", ParseUUIDPipe) id: string) {
    const row = await this.tenantDb.db.post.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    return row;
  }
}
