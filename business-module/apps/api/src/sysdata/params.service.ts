// 参数的读取：本租户自己设的值优先，没有就用平台给的默认值，再没有就用代码里的缺省。
// 已知的参数在这里登记了类型和取值范围；改值时按它校验，读值时不合规就退回缺省（不让一个填错的参数把功能弄坏）。
import { BadRequestException, Injectable } from "@nestjs/common";
import { TenantPrismaService } from "../tenancy/tenant-prisma.service";

export interface ParamDef { type: "int" | "bool" | "enum"; min?: number; max?: number; options?: readonly string[]; fallback: string }

/** 已知参数：键 → 类型、范围、缺省。键不在这里的参数是租户自己的（自由文本），不校验。 */
export const PARAM_DEFS: Record<string, ParamDef> = {
  "system.list.pageSize": { type: "int", min: 5, max: 100, fallback: "20" },
  "system.ui.defaultLocale": { type: "enum", options: ["en", "zh"], fallback: "en" },
  "edu.appeal.windowDays": { type: "int", min: 1, max: 90, fallback: "14" },
  "edu.appeal.maxPerCourse": { type: "int", min: 1, max: 10, fallback: "2" },
  "edu.extension.maxDays": { type: "int", min: 1, max: 30, fallback: "3" },
  "edu.submission.maxFiles": { type: "int", min: 1, max: 50, fallback: "10" },
  "edu.upload.maxMb": { type: "int", min: 1, max: 500, fallback: "20" },
  "library.upload.maxMb": { type: "int", min: 1, max: 2000, fallback: "50" },
};

/** 按登记的规则检查一个值；没问题返回 null，有问题返回原因。 */
export function paramProblem(key: string, value: string): string | null {
  const def = PARAM_DEFS[key];
  if (!def) return null;
  const v = value.trim();
  if (def.type === "int") {
    if (!/^-?\d+$/.test(v)) return "must be a whole number";
    const n = Number(v);
    if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) return `must be between ${def.min} and ${def.max}`;
  }
  if (def.type === "bool" && v !== "true" && v !== "false") return "must be true or false";
  if (def.type === "enum" && !def.options!.includes(v)) return `must be one of: ${def.options!.join(", ")}`;
  return null;
}

export function assertParam(key: string, value: string): void {
  const problem = paramProblem(key, value);
  if (problem) throw new BadRequestException(`${key} ${problem}`);
}

@Injectable()
export class ParamsService {
  constructor(private readonly tenantDb: TenantPrismaService) {}

  /** 当前租户生效的值（字符串）；已知参数不合规时退回缺省。 */
  async value(key: string): Promise<string | null> {
    const rows = await this.tenantDb.db.sysParam.findMany({ where: { key, deletedAt: null }, select: { value: true, tenantId: true } });
    const row = rows.find((r) => r.tenantId !== null) ?? rows[0];
    const def = PARAM_DEFS[key];
    if (!row) return def?.fallback ?? null;
    if (def && paramProblem(key, row.value)) return def.fallback;
    return row.value.trim();
  }

  async int(key: string): Promise<number> {
    return Number(await this.value(key));
  }

  /**
   * 上传大小上限（字节）：取租户的参数（MB），但不能超过运营方在环境变量里设的硬上限（试用站用它压低）。
   */
  async uploadLimitBytes(key: "edu.upload.maxMb" | "library.upload.maxMb", envName: "UPLOAD_MAX_BYTES" | "LIBRARY_MAX_BYTES"): Promise<number> {
    const bytes = (await this.int(key)) * 1024 * 1024;
    const cap = Number(process.env[envName]);
    return cap > 0 ? Math.min(bytes, cap) : bytes;
  }

  /** 延期天数不能超过本租户设的上限。 */
  async assertExtensionDays(days: number): Promise<void> {
    const max = await this.int("edu.extension.maxDays");
    if (days > max) throw new BadRequestException(`An extension is at most ${max} days`);
  }

  /** 前端要用的几个设置，随 /api/me 一起给。 */
  async uiSettings(): Promise<{ pageSize: number; defaultLocale: string; maxExtensionDays: number }> {
    return { pageSize: await this.int("system.list.pageSize"), defaultLocale: (await this.value("system.ui.defaultLocale")) ?? "en", maxExtensionDays: await this.int("edu.extension.maxDays") };
  }
}
