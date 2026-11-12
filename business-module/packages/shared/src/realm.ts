// Keycloak 域模板：把参数配置文件 + 租户信息变成可直接提交给 Keycloak 管理接口的域定义。
// 纯函数，不访问网络，所以可以单元测试；开通脚本和以后的租户开通服务共用它。
import realmConfig from "./realm-config.json";

export type RealmConfig = typeof realmConfig;
export const DEFAULT_REALM_CONFIG: RealmConfig = realmConfig;

export type RealmKind = "tenant" | "platform";

export interface RealmParams {
  kind: RealmKind;
  /** 租户代码；平台域固定为 "platform"。 */
  code: string;
  displayName: string;
  /** 写进令牌 `tenant_id` 声明的值（B1 起是租户表的 id；B0 先用租户代码）。 */
  tenantId: string;
  /** 前端的来源地址，如 http://hq.localhost:3001（回调地址据此生成）。 */
  webOrigin: string;
  smtp: { host: string; port: number; from: string; fromDisplayName: string };
  /** 仅本地冒烟测试：打开密码直连授权，让脚本不用浏览器就能换令牌。绝不用于正式开通。 */
  allowDirectGrant?: boolean;
  config?: RealmConfig;
}

export function realmName(kind: RealmKind, code: string): string {
  return kind === "platform" ? "platform" : `tenant-${code}`;
}

/** Keycloak 密码策略字符串，如 `length(10) and upperCase(1) and ...`。 */
export function passwordPolicyString(policy: RealmConfig["passwordPolicy"]): string {
  const parts = [
    `length(${policy.length})`,
    `upperCase(${policy.upperCase})`,
    `lowerCase(${policy.lowerCase})`,
    `digits(${policy.digits})`,
    `specialChars(${policy.specialChars})`,
  ];
  if (policy.notUsername) parts.push("notUsername");
  if (policy.notEmail) parts.push("notEmail");
  if (policy.history > 0) parts.push(`passwordHistory(${policy.history})`);
  if (policy.blacklistFile) parts.push(`passwordBlacklist(${policy.blacklistFile})`);
  return parts.join(" and ");
}

type Mapper = Record<string, unknown>;

function protocolMappers(params: RealmParams, cfg: RealmConfig): Mapper[] {
  return [
    {
      name: "tenant_id",
      protocol: "openid-connect",
      protocolMapper: "oidc-hardcoded-claim-mapper",
      config: {
        "claim.name": "tenant_id",
        "claim.value": params.tenantId,
        "jsonType.label": "String",
        "access.token.claim": "true",
        "id.token.claim": "true",
        "userinfo.token.claim": "true",
      },
    },
    {
      // 业务库账号 id，由 NestJS 创建账号时写进 Keycloak 用户的 account_id 属性
      name: "account_id",
      protocol: "openid-connect",
      protocolMapper: "oidc-usermodel-attribute-mapper",
      config: {
        "user.attribute": "account_id",
        "claim.name": "account_id",
        "jsonType.label": "String",
        "access.token.claim": "true",
        "id.token.claim": "true",
        "userinfo.token.claim": "true",
      },
    },
    {
      name: "api-audience",
      protocol: "openid-connect",
      protocolMapper: "oidc-audience-mapper",
      config: {
        "included.custom.audience": cfg.audience,
        "access.token.claim": "true",
        "id.token.claim": "false",
      },
    },
  ];
}

function client(
  params: RealmParams,
  cfg: RealmConfig,
  clientId: string,
  redirectPath: string,
  directGrant: boolean,
): Mapper {
  return {
    clientId,
    name: clientId,
    enabled: true,
    publicClient: true,
    protocol: "openid-connect",
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: directGrant,
    serviceAccountsEnabled: false,
    rootUrl: params.webOrigin,
    redirectUris: [`${params.webOrigin}${redirectPath}`],
    webOrigins: [params.webOrigin],
    attributes: { "pkce.code.challenge.method": "S256" },
    protocolMappers: protocolMappers(params, cfg),
  };
}

/** 生成域定义。租户域有两个客户端（学生门户、管理后台），平台域一个。 */
export function buildRealm(params: RealmParams): Record<string, unknown> {
  const cfg = params.config ?? DEFAULT_REALM_CONFIG;
  const direct = params.allowDirectGrant === true;
  const clients =
    params.kind === "platform"
      ? [client(params, cfg, "platform", "/*", direct)]
      : [
          client(params, cfg, "portal", "/*", direct),
          client(params, cfg, "admin", "/admin/*", direct),
        ];
  return {
    realm: realmName(params.kind, params.code),
    displayName: params.displayName,
    enabled: true,
    sslRequired: cfg.sslRequired,
    registrationAllowed: false,
    registrationEmailAsUsername: false,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    resetPasswordAllowed: true,
    editUsernameAllowed: false,
    verifyEmail: false,
    rememberMe: false,
    accessTokenLifespan: cfg.accessTokenLifespanSeconds,
    ssoSessionIdleTimeout: cfg.ssoSessionIdleTimeoutSeconds,
    ssoSessionMaxLifespan: cfg.ssoSessionMaxLifespanSeconds,
    actionTokenGeneratedByAdminLifespan: cfg.inviteLinkLifespanSeconds,
    actionTokenGeneratedByUserLifespan: cfg.resetLinkLifespanSeconds,
    passwordPolicy: passwordPolicyString(cfg.passwordPolicy),
    bruteForceProtected: true,
    permanentLockout: cfg.bruteForce.permanentLockout,
    failureFactor: cfg.bruteForce.failureFactor,
    waitIncrementSeconds: cfg.bruteForce.waitIncrementSeconds,
    maxFailureWaitSeconds: cfg.bruteForce.maxFailureWaitSeconds,
    maxDeltaTimeSeconds: cfg.bruteForce.maxDeltaTimeSeconds,
    minimumQuickLoginWaitSeconds: cfg.bruteForce.minimumQuickLoginWaitSeconds,
    eventsEnabled: true,
    eventsListeners: ["jboss-logging"],
    adminEventsEnabled: false,
    smtpServer: {
      host: params.smtp.host,
      port: String(params.smtp.port),
      from: params.smtp.from,
      fromDisplayName: params.smtp.fromDisplayName,
      auth: "false",
      ssl: "false",
      starttls: "false",
    },
    clients,
  };
}

// ---- 用户资料（Keycloak 的 User Profile）----
// 默认配置要求名和姓必填，我们的人员只有一个"姓名"，登录时会被判为"账号未完全设置"；
// 另外令牌里的 account_id 必须先在用户资料里声明，否则管理接口会丢掉这个属性。

interface ProfileAttribute {
  name: string;
  required?: unknown;
  [key: string]: unknown;
}
export interface UserProfileConfig {
  attributes: ProfileAttribute[];
  [key: string]: unknown;
}

export function adjustUserProfile(profile: UserProfileConfig): UserProfileConfig {
  const attributes = profile.attributes.map((attr) => {
    if (attr.name === "firstName" || attr.name === "lastName") {
      const { required: _required, ...rest } = attr;
      return rest as ProfileAttribute;
    }
    return attr;
  });
  if (!attributes.some((a) => a.name === "account_id")) {
    attributes.push({
      name: "account_id",
      displayName: "Account id",
      validations: {},
      annotations: {},
      permissions: { view: ["admin"], edit: ["admin"] },
      multivalued: false,
    });
  }
  return { ...profile, attributes };
}
