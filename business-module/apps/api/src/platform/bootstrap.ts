// 第一个平台账号：内置、拥有"平台超级管理员"角色。平台域本身由 `pnpm realm` 创建。
// 可重复运行：已有就补齐缺的部分（Keycloak 用户、角色），不重复创建。
import type { PrismaClient } from "../generated/prisma";
import type { KeycloakAdmin } from "../keycloak/keycloak-admin";
import { tenantOrigin } from "../keycloak/realm-provisioner";

export interface BootstrapResult {
  accountId: string;
  created: boolean;
  inviteSent: boolean;
  inviteError?: string;
}

export async function bootstrapPlatformAccount(
  db: PrismaClient,
  keycloak: KeycloakAdmin,
  input: { username: string; email: string; password?: string; sendInvite?: boolean },
): Promise<BootstrapResult> {
  const superRole = await db.platformRole.findFirstOrThrow({ where: { kind: "super", deletedAt: null } });
  let account = await db.platformAccount.findUnique({ where: { username: input.username } });
  const created = !account;
  account ??= await db.platformAccount.create({ data: { username: input.username, email: input.email, status: "pending", isBuiltin: true } });
  await db.platformAccountRole.upsert({ where: { accountId_roleId: { accountId: account.id, roleId: superRole.id } }, create: { accountId: account.id, roleId: superRole.id }, update: {} });
  let inviteSent = false;
  let inviteError: string | undefined;
  if (!account.keycloakUserId) {
    const existing = await keycloak.findUser("platform", account.username);
    const userId = existing?.id ?? (await keycloak.createUser("platform", { username: account.username, email: account.email ?? undefined, accountId: account.id, password: input.password }));
    account = await db.platformAccount.update({ where: { id: account.id }, data: { keycloakUserId: userId } });
    if (input.sendInvite !== false && !input.password) {
      try {
        await keycloak.sendInvite("platform", userId, "platform", tenantOrigin("platform"));
        inviteSent = true;
      } catch (err) {
        inviteError = err instanceof Error ? err.message : String(err);
      }
    }
  }
  return { accountId: account.id, created, inviteSent, inviteError };
}
