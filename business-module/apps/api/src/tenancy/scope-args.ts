// 给每个 Prisma 操作的参数加上租户条件。纯函数，单独测试。
// 这是第二道防线：第一道是请求入口按主机名确定租户，第三道是数据库的行级安全。
// Prisma 各操作的参数形状不同，这里按普通对象处理，改写逻辑由单元测试覆盖
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

interface ModelRule {
  /** tenant_id 是否可为空（平台提供的行，租户只读） */
  nullable: boolean;
  /** 是否有 deleted_at（软删除） */
  softDelete: boolean;
}

export const TENANT_MODELS: Record<string, ModelRule> = {
  Person: { nullable: false, softDelete: true },
  Account: { nullable: false, softDelete: true },
  AccountRole: { nullable: false, softDelete: false },
  TenantMenuGrant: { nullable: false, softDelete: false },
  Dept: { nullable: false, softDelete: true },
  Campus: { nullable: false, softDelete: true },
  Post: { nullable: false, softDelete: true },
  Role: { nullable: true, softDelete: true },
  Menu: { nullable: true, softDelete: true },
  EntryMenu: { nullable: true, softDelete: false },
  RoleMenu: { nullable: true, softDelete: false },
  DataScopeSet: { nullable: true, softDelete: true },
  DataScopeSetNode: { nullable: false, softDelete: false },
  RoleDataScope: { nullable: true, softDelete: false },
  PersonDept: { nullable: false, softDelete: false },
  LoginLog: { nullable: false, softDelete: false },
  AuditLog: { nullable: false, softDelete: false },
  DictType: { nullable: true, softDelete: true },
  DictItem: { nullable: true, softDelete: true },
  SysParam: { nullable: true, softDelete: true },
  OperationLog: { nullable: false, softDelete: false },
  StaffProfile: { nullable: false, softDelete: false },
  StudentProfile: { nullable: false, softDelete: false },
  EmergencyContact: { nullable: false, softDelete: false },
  Term: { nullable: false, softDelete: true },
  Major: { nullable: false, softDelete: true },
  Course: { nullable: false, softDelete: true },
  CoursePrerequisite: { nullable: false, softDelete: false },
  MajorCourse: { nullable: false, softDelete: false },
  MajorVersion: { nullable: false, softDelete: false },
  StudentRequest: { nullable: false, softDelete: false },
  StudentMajor: { nullable: false, softDelete: false },
  Section: { nullable: false, softDelete: false },
  SectionInstructor: { nullable: false, softDelete: false },
  Enrollment: { nullable: false, softDelete: false },
  SectionMaterial: { nullable: false, softDelete: false },
  OutboxEvent: { nullable: false, softDelete: false },
  AssignmentGroup: { nullable: false, softDelete: false },
  Assignment: { nullable: false, softDelete: false },
  RubricItem: { nullable: false, softDelete: false },
  AssignmentExtension: { nullable: false, softDelete: false },
  Submission: { nullable: false, softDelete: false },
  SubmissionVersion: { nullable: false, softDelete: false },
  SubmissionFile: { nullable: false, softDelete: false },
  SubmissionScore: { nullable: false, softDelete: false },
  GradingScaleItem: { nullable: false, softDelete: false },
  ManualGrade: { nullable: false, softDelete: false },
  FinalGrade: { nullable: false, softDelete: false },
  GradeChange: { nullable: false, softDelete: false },
  TranscriptIssue: { nullable: false, softDelete: false },
  Notification: { nullable: false, softDelete: false },
  NotificationPreference: { nullable: false, softDelete: false },
  Announcement: { nullable: false, softDelete: false },
  DiscussionPost: { nullable: false, softDelete: false },
  DocFolder: { nullable: false, softDelete: false },
  DocAcl: { nullable: false, softDelete: false },
  DocFile: { nullable: false, softDelete: false },
  DocFileVersion: { nullable: false, softDelete: false },
  DocUpload: { nullable: false, softDelete: false },
  DocAccessLog: { nullable: false, softDelete: false },
};

export class TenantScopeError extends Error {}

const READS = new Set(["findMany", "findFirst", "findFirstOrThrow", "count", "aggregate", "groupBy"]);
const UNIQUE_READS = new Set(["findUnique", "findUniqueOrThrow"]);
const UNIQUE_WRITES = new Set(["update", "delete"]);
const MANY_WRITES = new Set(["updateMany", "deleteMany"]);
const CREATES = new Set(["create", "createMany", "createManyAndReturn"]);

function and(where: unknown, extra: Args): Args {
  return where ? { AND: [where, extra] } : extra;
}

function forceTenant(row: Args, tenantId: string): Args {
  if (row.tenantId !== undefined && row.tenantId !== tenantId) {
    throw new TenantScopeError("tenantId must be the current tenant");
  }
  if (row.tenant !== undefined) throw new TenantScopeError("cannot set the tenant relation directly");
  return { ...row, tenantId };
}

/** 返回改写后的参数；不该做的操作直接抛错。 */
export function scopeArgs(model: string, operation: string, args: Args | undefined, tenantId: string): Args | undefined {
  const rule = TENANT_MODELS[model];
  if (!rule) return args;
  const a: Args = { ...(args ?? {}) };

  if (READS.has(operation)) {
    const filter: Args = rule.nullable ? { OR: [{ tenantId }, { tenantId: null }] } : { tenantId };
    let where = and(a.where, filter);
    if (rule.softDelete && !(a.where && "deletedAt" in a.where)) where = and(where, { deletedAt: null });
    return { ...a, where };
  }
  if (UNIQUE_READS.has(operation)) {
    // 唯一键查询不能写 OR 条件：严格表加上 tenantId，平台可空表交给行级安全
    return rule.nullable ? a : { ...a, where: { ...a.where, tenantId } };
  }
  if (UNIQUE_WRITES.has(operation) || operation === "upsert") {
    if (operation === "delete" && rule.softDelete) {
      throw new TenantScopeError(`hard delete of ${model} is not allowed; set deletedAt instead`);
    }
    const out: Args = { ...a, where: { ...a.where, tenantId } };
    if (operation === "update" && a.data) {
      if ("tenantId" in a.data || "tenant" in a.data) throw new TenantScopeError("tenantId cannot be changed");
    }
    if (operation === "upsert") {
      out.create = forceTenant(a.create ?? {}, tenantId);
      if (a.update && ("tenantId" in a.update || "tenant" in a.update)) {
        throw new TenantScopeError("tenantId cannot be changed");
      }
    }
    return out;
  }
  if (MANY_WRITES.has(operation)) {
    if (operation === "deleteMany" && rule.softDelete) {
      throw new TenantScopeError(`hard delete of ${model} is not allowed; set deletedAt instead`);
    }
    if (operation === "updateMany" && a.data && ("tenantId" in a.data || "tenant" in a.data)) {
      throw new TenantScopeError("tenantId cannot be changed");
    }
    return { ...a, where: and(a.where, { tenantId }) };
  }
  if (CREATES.has(operation)) {
    if (operation === "create") return { ...a, data: forceTenant(a.data ?? {}, tenantId) };
    const rows = Array.isArray(a.data) ? a.data : [a.data ?? {}];
    const forced = rows.map((r: Args) => forceTenant(r, tenantId));
    return { ...a, data: Array.isArray(a.data) ? forced : forced[0] };
  }
  throw new TenantScopeError(`operation ${operation} on ${model} is not supported in a tenant context`);
}

/** 唯一键读取之后过滤已软删除的行。 */
export function filterSoftDeleted<T>(model: string, operation: string, result: T): T {
  const rule = TENANT_MODELS[model];
  if (!rule?.softDelete || !UNIQUE_READS.has(operation)) return result;
  const row = result as Args | null;
  if (row && row.deletedAt) {
    if (operation === "findUniqueOrThrow") throw new TenantScopeError(`${model} not found`);
    return null as T;
  }
  return result;
}
