// 公开试用站的保护：试用者能点遍所有功能、能新建和编辑，但不能做"会让站点失控或被滥用"的事。
// 做法是一份禁用清单（不是只读）：
//   - 只在 TRIAL_PROTECT=1 时生效（普通部署完全不受影响）；
//   - 租户入口只对"演示公司"生效，真实公司即使误开了开关也不受影响；
//   - 平台入口没有"哪家公司"的概念，开关打开时整体生效（公开试用站的平台入口只用来演示）。
// 被拒绝的请求返回 403 + code "trial_restricted"，界面会显示这句话。
// 数据每天由 `pnpm demo:reset` 重建（见 deploy/trial），所以允许的写操作不需要回滚。

export const TRIAL_RESTRICTED_MESSAGE = "This action is turned off in the public trial.";

interface Rule {
  methods: string[];
  /** 匹配去掉结尾斜杠后的路径 */
  path: RegExp;
}

// 租户入口（演示公司）：账号生命周期和凭据 —— 会发邮件、会改登录、会让别人进不来
const TENANT_RULES: Rule[] = [
  { methods: ["POST"], path: /^\/api\/accounts$/ }, // 新建账号（会在身份系统里建用户）
  { methods: ["POST"], path: /^\/api\/accounts\/reconcile$/ },
  { methods: ["PATCH"], path: /^\/api\/accounts\/[^/]+\/status$/ }, // 停用账号
  { methods: ["PATCH"], path: /^\/api\/accounts\/[^/]+\/email$/ },
  { methods: ["POST"], path: /^\/api\/accounts\/[^/]+\/(invite|reset-link|temp-password|unlock)$/ },
];

// 平台入口：公司的开通、停用、登录安全，平台账号，目录和入口的结构
const PLATFORM_RULES: Rule[] = [
  { methods: ["POST"], path: /^\/api\/platform\/tenants$/ },
  { methods: ["PATCH"], path: /^\/api\/platform\/tenants\/[^/]+$/ },
  { methods: ["POST"], path: /^\/api\/platform\/tenants\/[^/]+\/status$/ },
  { methods: ["POST", "PATCH"], path: /^\/api\/platform\/tenants\/[^/]+\/admin(\/.*)?$/ },
  { methods: ["PUT", "DELETE"], path: /^\/api\/platform\/tenants\/[^/]+\/security(\/.*)?$/ },
  { methods: ["POST", "PUT"], path: /^\/api\/platform\/accounts(\/.*)?$/ },
  { methods: ["PATCH"], path: /^\/api\/platform\/accounts\/[^/]+\/status$/ },
  { methods: ["POST", "DELETE"], path: /^\/api\/platform\/roles(\/.*)?$/ },
  { methods: ["PUT"], path: /^\/api\/platform\/roles\/[^/]+\/menus$/ },
  { methods: ["PATCH"], path: /^\/api\/platform\/menus\/[^/]+$/ },
  { methods: ["PUT"], path: /^\/api\/platform\/entries\/[^/]+\/menus$/ },
];

export function trialProtectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TRIAL_PROTECT === "1";
}

export function isTrialBlocked(kind: "tenant" | "platform", method: string, path: string): boolean {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const m = method.toUpperCase();
  const rules = kind === "tenant" ? TENANT_RULES : PLATFORM_RULES;
  return rules.some((r) => r.methods.includes(m) && r.path.test(p));
}
