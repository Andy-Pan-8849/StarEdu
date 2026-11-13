import { Body, Controller, Post } from "@nestjs/common";
import { z } from "zod";
import { PERMS } from "@staredu/shared";
import { AuditService } from "../audit/audit.service";
import { RequirePermissions } from "../auth/decorators";
import type { AuthContext } from "../auth/tenant-token.guard";
import { Auth, parse } from "../common/http";
import { AuthzService } from "../rbac/authz.service";
import { ImportService, type ImportResult } from "./import.service";

const schema = z.object({ csv: z.string().min(1).max(5_000_000), dryRun: z.boolean().optional(), campusAliases: z.record(z.string(), z.string()).optional() });

@Controller("api/import")
export class ImportController {
  constructor(
    private readonly imports: ImportService,
    private readonly audit: AuditService,
    private readonly authz: AuthzService,
  ) {}

  private async finish(auth: AuthContext, kind: string, result: ImportResult) {
    if (!result.dryRun) {
      await this.authz.bump(auth.tenantId);
      await this.audit.record(auth.accountId, `import.${kind}`, "import", null, { created: result.created, updated: result.updated, unchanged: result.unchanged, errors: result.errors.length });
    }
    return { ...result, errors: result.errors.slice(0, 100), changes: result.changes.slice(0, 100), errorCount: result.errors.length };
  }

  @Post("campuses")
  @RequirePermissions(PERMS.campusAdd)
  async campuses(@Auth() auth: AuthContext, @Body() body: unknown) {
    const { csv, ...opts } = parse(schema, body);
    return this.finish(auth, "campuses", await this.imports.importCampuses(auth, PERMS.campusAdd, csv, opts));
  }

  @Post("staff")
  @RequirePermissions(PERMS.hrStaffImport)
  async staff(@Auth() auth: AuthContext, @Body() body: unknown) {
    const { csv, ...opts } = parse(schema, body);
    return this.finish(auth, "staff", await this.imports.importStaff(auth, csv, opts));
  }

  @Post("students")
  @RequirePermissions(PERMS.hrStudentImport)
  async students(@Auth() auth: AuthContext, @Body() body: unknown) {
    const { csv, ...opts } = parse(schema, body);
    return this.finish(auth, "students", await this.imports.importStudents(auth, csv, opts));
  }
}
