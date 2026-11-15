// 通知文字模板：中英文两套。站内消息存的是"类型 + 参数"，读取时按收件人的语言渲染；邮件发送时同样渲染。
export type Locale = "en" | "zh";
export const CATEGORIES = ["enrollment", "assignment", "grade", "reminder", "announcement", "discussion", "request"] as const;
export type Category = (typeof CATEGORIES)[number];

interface Template {
  category: Category;
  en: { title: string; body: string };
  zh: { title: string; body: string };
}

export const TEMPLATES: Record<string, Template> = {
  "enrollment.registrar_added": {
    category: "enrollment",
    en: { title: "You were enrolled in {section}", body: "The registrar enrolled you in {section}." },
    zh: { title: "你已被选入 {section}", body: "教务已将你加入 {section}。" },
  },
  "enrollment.registrar_removed": {
    category: "enrollment",
    en: { title: "You were removed from {section}", body: "The registrar removed you from {section} (record: {status})." },
    zh: { title: "你已被移出 {section}", body: "教务已将你从 {section} 移出（记录：{status}）。" },
  },
  "section.cancelled": {
    category: "enrollment",
    en: { title: "{section} was cancelled", body: "{section} was cancelled and your enrollment was voided." },
    zh: { title: "{section} 已取消", body: "{section} 已取消，你的选课记录已作废。" },
  },
  "assignment.published": {
    category: "assignment",
    en: { title: "New assignment: {title}", body: "{section}: due {dueDate}." },
    zh: { title: "新作业：{title}", body: "{section}：截止 {dueDate}。" },
  },
  "submission.published": {
    category: "grade",
    en: { title: "Your score is published: {title}", body: "{section}: your score for {title} is now available." },
    zh: { title: "作业得分已发布：{title}", body: "{section}：你的《{title}》得分已发布。" },
  },
  "final_grade.published": {
    category: "grade",
    en: { title: "Final grade published: {section}", body: "Your final grade for {section} is now available." },
    zh: { title: "最终成绩已发布：{section}", body: "你在 {section} 的最终成绩已发布。" },
  },
  "request.appeal_submitted": {
    category: "request",
    en: { title: "Grade appeal in {section}", body: "{student} appealed the final grade for {section}." },
    zh: { title: "{section} 有新的成绩复评申请", body: "{student} 对 {section} 的最终成绩提出了复评。" },
  },
  "request.extension_submitted": {
    category: "request",
    en: { title: "Extension request in {section}", body: "{student} asked for {days} more day(s) on {title}." },
    zh: { title: "{section} 有新的延期申请", body: "{student} 申请《{title}》延期 {days} 天。" },
  },
  "request.appeal_approved": {
    category: "request",
    en: { title: "Your grade appeal was approved: {section}", body: "The grade for {section} was changed. Note: {note}" },
    zh: { title: "你的成绩复评已通过：{section}", body: "{section} 的成绩已更正。说明：{note}" },
  },
  "request.appeal_rejected": {
    category: "request",
    en: { title: "Your grade appeal was rejected: {section}", body: "The grade for {section} stays. Note: {note}" },
    zh: { title: "你的成绩复评未通过：{section}", body: "{section} 的成绩维持不变。说明：{note}" },
  },
  "request.extension_approved": {
    category: "request",
    en: { title: "Your extension was approved: {title}", body: "{section}: you now have {days} extra day(s) on {title}. Note: {note}" },
    zh: { title: "你的延期申请已通过：{title}", body: "{section}：《{title}》延期 {days} 天。说明：{note}" },
  },
  "request.extension_rejected": {
    category: "request",
    en: { title: "Your extension was rejected: {title}", body: "{section}: the deadline for {title} stays. Note: {note}" },
    zh: { title: "你的延期申请未通过：{title}", body: "{section}：《{title}》的截止时间不变。说明：{note}" },
  },
  "discussion.posted": {
    category: "discussion",
    en: { title: "New discussion in {section}: {title}", body: "{author} started a discussion." },
    zh: { title: "{section} 有新讨论：{title}", body: "{author} 发起了讨论。" },
  },
  "discussion.replied": {
    category: "discussion",
    en: { title: "New reply in {section}: {title}", body: "{author} replied." },
    zh: { title: "{section} 的讨论有新回复：{title}", body: "{author} 回复了。" },
  },
  "discussion.resolved": {
    category: "discussion",
    en: { title: "Marked as solved: {title}", body: "Your discussion in {section} was marked as solved." },
    zh: { title: "讨论已标记为已解决：{title}", body: "你在 {section} 发起的讨论已标记为已解决。" },
  },
  "reminder.deadline": {
    category: "reminder",
    en: { title: "Due soon: {title}", body: "{section}: due {deadline}. You have not submitted yet." },
    zh: { title: "即将截止：{title}", body: "{section}：截止 {deadline}，你还没有提交。" },
  },
};

export const categoryOf = (type: string): Category => (type === "announcement" ? "announcement" : (TEMPLATES[type]?.category ?? "announcement"));

export function render(type: string, params: Record<string, unknown>, locale: Locale): { title: string; body: string } {
  const t = TEMPLATES[type];
  if (!t) return { title: type, body: "" };
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(params[k] ?? ""));
  return { title: fill(t[locale].title), body: fill(t[locale].body) };
}

/** 用户存的语言优先，其次请求头 Accept-Language，最后英文。 */
export function pickLocale(stored: string | null | undefined, header?: string | null): Locale {
  if (stored === "en" || stored === "zh") return stored;
  return /^\s*zh/i.test(header ?? "") ? "zh" : "en";
}

export const EMAIL_FOOTER: Record<Locale, (category: string, url: string) => string> = {
  en: (category, url) => `--\nYou get this e-mail because of your notification settings. Stop "${category}" e-mails: ${url}`,
  zh: (category, url) => `--\n你收到这封邮件是因为通知设置。不再接收“${category}”类邮件：${url}`,
};
