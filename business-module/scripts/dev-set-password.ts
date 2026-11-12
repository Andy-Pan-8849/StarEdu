// 仅本地开发：给某个租户域里的用户直接设一个密码（邀请邮件的链接太麻烦时用）。
//   pnpm dev:password --code hq --username admin --password '<至少 10 位，含大小写、数字、特殊字符>'
// 只在 Keycloak 地址是本机时才执行，避免误改线上环境。
import { parseArgs } from "node:util";
import { KeycloakAdmin, keycloakEnv } from "../apps/api/src/keycloak/keycloak-admin";
import { loadLocalEnv } from "./lib/keycloak";

async function main(): Promise<void> {
  loadLocalEnv();
  const { values } = parseArgs({ options: { code: { type: "string" }, username: { type: "string", default: "admin" }, password: { type: "string" } } });
  if (!values.code || !values.password) throw new Error("usage: pnpm dev:password --code <tenant code> [--username admin] --password <password>");
  const env = keycloakEnv();
  const host = new URL(env.url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`refusing to set a password on a non-local Keycloak (${host})`);
  const admin = await KeycloakAdmin.connect(env);
  const realm = `tenant-${values.code}`; // 与 packages/shared 的 realmName 同一规则
  const user = await admin.findUser(realm, values.username as string);
  if (!user) throw new Error(`user "${values.username}" not found in ${realm}`);
  const res = await admin.request(`/realms/${realm}/users/${user.id}/reset-password`, {
    method: "PUT",
    body: JSON.stringify({ type: "password", value: values.password, temporary: false }),
  });
  if (res.status !== 204) throw new Error(`could not set the password: ${res.status} ${await res.text()}`);
  console.log(`password set for ${values.username} in ${realm}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
