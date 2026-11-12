// 外键不受行级安全约束（Postgres 做外键检查时绕过策略），所以凡是接收"关联 id"的接口，
// 都要先确认这些 id 属于当前租户（或是平台提供、本租户可见的行）。
// 传进来的必须是租户感知的客户端的某个模型（它自己会按租户过滤），所以"查得到"就等于"可见"。
import { BadRequestException } from "@nestjs/common";

interface Finder {
  findMany(args: { where: { id: { in: string[] } }; select: { id: true } }): Promise<Array<{ id: string }>>;
}

/** 这些 id 必须全部可见；否则 400，错误信息里不透露哪个 id、也不区分"不存在"和"别人的"。 */
export async function assertVisible(model: Finder, ids: string[], what: string): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const found = await model.findMany({ where: { id: { in: unique } }, select: { id: true } });
  if (found.length !== unique.length) throw new BadRequestException(`Unknown ${what}`);
}
