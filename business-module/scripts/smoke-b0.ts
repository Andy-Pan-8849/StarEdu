// B0 冒烟：建一个临时租户域，验证
//   1) 令牌里有 tenant_id、account_id、受众，寿命 15 分钟，签发者是该域；
//   2) 弱密码被拒绝（长度/缺特殊字符/弱口令名单）；
//   3) 连续输错 5 次后账号被临时锁定；
//   4) 管理员触发的"设置密码"邮件到达 Mailpit。
// 最后无论成败都删除这个临时域。用法：pnpm smoke（需要先 make up）。
import { createRealm } from "./create-realm";
import { KeycloakAdmin, loadLocalEnv } from "./lib/keycloak";

const CODE = "smoke";
const REALM = `tenant-${CODE}`;
const GOOD_PASSWORD = "Str0ng!Passw0rd";

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

async function createUser(admin: KeycloakAdmin, username: string, email: string, password: string) {
  return admin.request(`/realms/${REALM}/users`, {
    method: "POST",
    body: JSON.stringify({
      username,
      email,
      emailVerified: true,
      enabled: true,
      attributes: { account_id: ["acct-123"] },
      credentials: [{ type: "password", value: password, temporary: false }],
    }),
  });
}

async function tokenRequest(url: string, username: string, password: string): Promise<Response> {
  return fetch(`${url}/realms/${REALM}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "portal", username, password }),
  });
}

function decodePayload(jwt: string): Record<string, any> {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
}

async function main(): Promise<void> {
  loadLocalEnv();
  const admin = await KeycloakAdmin.connect();
  const mailpit = process.env.MAILPIT_API_URL ?? "http://localhost:8125";
  try {
    console.log(await createRealm(admin, { kind: "tenant", code: CODE, name: "Smoke", recreate: true, allowDirectGrant: true }));

    // 2) 弱密码
    for (const [label, password] of [
      ["too short", "Ab1!"],
      ["no special character", "Abcdefghij1"],
      ["no uppercase", "abcdefghi1!"],
      ["on the weak list", "Password123"],
    ] as const) {
      const res = await createUser(admin, `weak.${label.replace(/\W+/g, "")}`, `weak-${label.length}@example.test`, password);
      check(res.status === 400, `weak password rejected: ${label}`, `status ${res.status}`);
    }

    // 1) 令牌声明
    const created = await createUser(admin, "smoke.user", "smoke@example.test", GOOD_PASSWORD);
    check(created.status === 201, "strong password accepted", `status ${created.status}`);
    const tokenRes = await tokenRequest(admin.url, "smoke.user", GOOD_PASSWORD);
    check(tokenRes.ok, "password login returns a token", `status ${tokenRes.status}`);
    if (tokenRes.ok) {
      const claims = decodePayload(((await tokenRes.json()) as { access_token: string }).access_token);
      check(claims.tenant_id === CODE, "token has tenant_id", String(claims.tenant_id));
      check(claims.account_id === "acct-123", "token has account_id", String(claims.account_id));
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      check(aud.includes("staredu-api"), "token audience includes staredu-api", aud.join(","));
      check(String(claims.iss).endsWith(`/realms/${REALM}`), "issuer is this tenant's realm", String(claims.iss));
      check(claims.exp - claims.iat === 900, "access token lives 15 minutes", String(claims.exp - claims.iat));
    }

    // 域设置回读
    const realm = await admin.getRealm(REALM);
    check(
      realm.passwordPolicy ===
        "length(10) and upperCase(1) and lowerCase(1) and digits(1) and specialChars(1) and notUsername and notEmail and passwordHistory(2) and passwordBlacklist(common-weak.txt)",
      "password policy stored",
    );
    check(realm.bruteForceProtected === true && realm.failureFactor === 5 && realm.waitIncrementSeconds === 600, "lockout parameters stored");

    // 3) 输错 5 次后锁定
    for (let i = 0; i < 5; i += 1) await tokenRequest(admin.url, "smoke.user", "Wrong!Passw0rd1");
    const locked = await tokenRequest(admin.url, "smoke.user", GOOD_PASSWORD);
    check(locked.status === 400 || locked.status === 401, "correct password rejected after 5 failures", `status ${locked.status}`);

    // 4) 邮件
    await fetch(`${mailpit}/api/v1/messages`, { method: "DELETE" });
    const users = (await (await admin.request(`/realms/${REALM}/users?username=smoke.user&exact=true`)).json()) as Array<{ id: string }>;
    const send = await admin.request(
      `/realms/${REALM}/users/${users[0].id}/execute-actions-email?client_id=portal&redirect_uri=${encodeURIComponent("http://smoke.localhost:3001/")}`,
      { method: "PUT", body: JSON.stringify(["UPDATE_PASSWORD"]) },
    );
    check(send.status === 204, "Keycloak accepted the set-password email", `status ${send.status}`);
    let found = false;
    for (let i = 0; i < 10 && !found; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const list = (await (await fetch(`${mailpit}/api/v1/messages`)).json()) as { messages: Array<{ To: Array<{ Address: string }> }> };
      found = list.messages.some((m) => m.To.some((t) => t.Address === "smoke@example.test"));
    }
    check(found, "email arrived in Mailpit for smoke@example.test");
  } finally {
    await admin.deleteRealm(REALM);
    console.log(`${REALM}: removed`);
  }
  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("all checks passed");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
