// 租户"登录与安全"：平台运维在平台入口调整某个租户域的密码策略、登录失败锁定、会话时长、两步验证，
// 并为租户开关 Google 登录。设置存在 Keycloak 域里（那是登录时真正查的地方），这里只是读写它们；
// 每次修改写平台审计日志（密钥不进日志）。
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  applySecurityToRealm,
  GOOGLE_ALIAS,
  googleProvider,
  googleRedirectUri,
  LINK_ONLY_FLOW_ALIAS,
  mfaFromOtpRequirement,
  realmName,
  securityFromRealm,
  securityProblems,
  type GoogleStatus,
  type TenantSecurity,
} from "@staredu/shared";
import { KeycloakService } from "../keycloak/keycloak.service";
import type { KeycloakAdmin } from "../keycloak/keycloak-admin";
import { PlatformPrismaService } from "./platform-prisma.service";
import { PlatformAuditService } from "./platform-audit.service";

const OTP_SUBFLOW = "Browser - Conditional 2FA";
const BROWSER_FLOW = "browser";

@Injectable()
export class TenantSecurityService {
  constructor(
    private readonly db: PlatformPrismaService,
    private readonly keycloak: KeycloakService,
    private readonly audit: PlatformAuditService,
  ) {}

  private async realmOf(id: string): Promise<string> {
    const t = await this.db.tenant.findUnique({ where: { id } });
    if (!t) throw new NotFoundException("Tenant not found");
    return realmName("tenant", t.code);
  }

  /** 浏览器里能打开的 Keycloak 地址（回调地址据此生成）。 */
  private publicUrl(kc: KeycloakAdmin): string {
    return process.env.KEYCLOAK_PUBLIC_URL ?? kc.url;
  }

  private async otpExecutions(kc: KeycloakAdmin, realm: string) {
    const all = await kc.executions(realm, BROWSER_FLOW);
    const start = all.findIndex((e) => e.displayName === OTP_SUBFLOW);
    if (start < 0) throw new ConflictException("The sign-in flow of this tenant has no two-step step (was it changed by hand?)");
    const sub = all[start];
    const inside = all.slice(start + 1).filter((e) => (e.level ?? 0) > (sub.level ?? 0));
    const stop = inside.findIndex((e, i) => i > 0 && (e.level ?? 0) <= (sub.level ?? 0));
    const members = stop < 0 ? inside : inside.slice(0, stop);
    const find = (provider: string) => members.find((e) => e.providerId === provider);
    return { sub, otp: find("auth-otp-form"), conditions: [find("conditional-user-configured"), find("conditional-credential")].filter((e): e is NonNullable<typeof e> => !!e) };
  }

  async get(id: string): Promise<{ security: TenantSecurity; google: GoogleStatus; realm: string }> {
    const realm = await this.realmOf(id);
    const kc = await this.keycloak.client();
    const rep = await kc.getRealm(realm);
    const { otp } = await this.otpExecutions(kc, realm);
    return { realm, security: securityFromRealm(rep, mfaFromOtpRequirement(otp?.requirement)), google: await this.googleStatus(kc, realm) };
  }

  private async googleStatus(kc: KeycloakAdmin, realm: string): Promise<GoogleStatus> {
    const idp = await kc.getIdp(realm, GOOGLE_ALIAS);
    return {
      configured: !!idp,
      enabled: idp?.enabled === true,
      clientId: (idp?.config?.clientId as string | undefined) ?? null,
      hasSecret: !!idp?.config?.clientSecret,
      redirectUri: googleRedirectUri(this.publicUrl(kc), realm),
    };
  }

  async update(actorId: string, id: string, input: TenantSecurity) {
    const problems = securityProblems(input);
    if (problems.length) throw new BadRequestException(problems.join("; "));
    const realm = await this.realmOf(id);
    const kc = await this.keycloak.client();
    const before = securityFromRealm(await kc.getRealm(realm), mfaFromOtpRequirement((await this.otpExecutions(kc, realm)).otp?.requirement));
    await kc.updateRealm(realm, applySecurityToRealm(await kc.getRealm(realm), input));
    await this.setMfa(kc, realm, input.mfa);
    await this.audit.record(actorId, "tenant.security", "tenant", id, { before, after: input });
    return this.get(id);
  }

  /** all：整段两步验证改成必经，OTP 一项必需、条件不再判断；off：恢复成"用户自己设置了才问"。 */
  private async setMfa(kc: KeycloakAdmin, realm: string, mode: "off" | "all"): Promise<void> {
    const { sub, otp, conditions } = await this.otpExecutions(kc, realm);
    if (!otp) throw new ConflictException("The sign-in flow of this tenant has no authenticator-app step");
    if (mode === "all") {
      for (const c of conditions) await kc.setRequirement(realm, BROWSER_FLOW, c, "DISABLED");
      await kc.setRequirement(realm, BROWSER_FLOW, otp, "REQUIRED");
      await kc.setRequirement(realm, BROWSER_FLOW, sub, "REQUIRED");
    } else {
      await kc.setRequirement(realm, BROWSER_FLOW, sub, "CONDITIONAL");
      await kc.setRequirement(realm, BROWSER_FLOW, otp, "ALTERNATIVE");
      for (const c of conditions) await kc.setRequirement(realm, BROWSER_FLOW, c, "REQUIRED");
    }
  }

  // ---------------------------------------------------------------- Google 登录
  /** 只关联已有账号的首次登录流程：先找邮箱相同的已有用户并自动关联；没有就拒绝，绝不新建账号。 */
  private async ensureLinkOnlyFlow(kc: KeycloakAdmin, realm: string): Promise<void> {
    if (await kc.flowExists(realm, LINK_ONLY_FLOW_ALIAS)) return;
    await kc.createFlow(realm, LINK_ONLY_FLOW_ALIAS, "Sign in with a social account only when a user with the same verified e-mail already exists");
    await kc.addExecution(realm, LINK_ONLY_FLOW_ALIAS, "idp-detect-existing-broker-user");
    await kc.addExecution(realm, LINK_ONLY_FLOW_ALIAS, "idp-auto-link");
    for (const e of await kc.executions(realm, LINK_ONLY_FLOW_ALIAS)) await kc.setRequirement(realm, LINK_ONLY_FLOW_ALIAS, e, "REQUIRED");
  }

  async setGoogle(actorId: string, id: string, input: { clientId: string; clientSecret?: string; enabled: boolean }) {
    const realm = await this.realmOf(id);
    const kc = await this.keycloak.client();
    const existing = await kc.getIdp(realm, GOOGLE_ALIAS);
    if (!existing && !input.clientSecret) throw new BadRequestException("The client secret is required the first time");
    await this.ensureLinkOnlyFlow(kc, realm);
    // 没给新密钥就沿用旧的（Keycloak 读出来是掩码，原样写回表示不改）
    const secret = input.clientSecret || (existing?.config?.clientSecret as string);
    const rep = googleProvider({ clientId: input.clientId, clientSecret: secret, enabled: input.enabled });
    if (existing) await kc.updateIdp(realm, GOOGLE_ALIAS, { ...existing, ...rep, config: { ...existing.config, ...(rep.config as object) } });
    else await kc.createIdp(realm, rep);
    await this.audit.record(actorId, existing ? "tenant.google.update" : "tenant.google.create", "tenant", id, { clientId: input.clientId, enabled: input.enabled, secretChanged: !!input.clientSecret });
    return this.googleStatus(kc, realm);
  }

  async removeGoogle(actorId: string, id: string) {
    const realm = await this.realmOf(id);
    const kc = await this.keycloak.client();
    await kc.deleteIdp(realm, GOOGLE_ALIAS);
    await this.audit.record(actorId, "tenant.google.remove", "tenant", id);
    return this.googleStatus(kc, realm);
  }
}
