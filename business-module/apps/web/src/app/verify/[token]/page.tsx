import { headers } from "next/headers";
import { callApi } from "@/lib/auth/api-client";
import { webAuthConfig } from "@/lib/auth/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "Transcript verification", robots: { index: false, follow: false } };

interface Verified {
  docNumber: string;
  official: boolean;
  issuedAt: string;
  status: "valid" | "revoked";
  revokedAt: string | null;
  fingerprint: string | null;
  details: { institution: string; studentName: string; studentNo: string | null; major: string | null; campus: string | null; cumulativeGpa: number | null; creditsEarned: number; creditsAttempted: number } | null;
}

const TEXT = {
  en: {
    title: "Transcript verification", notFound: "No transcript matches this link. Check that you scanned the whole code, or ask the student for a new copy.", tooMany: "Too many attempts. Please wait a minute and try again.", unavailable: "The service is temporarily unavailable.",
    valid: "This document was issued by the institution.", revoked: "This document has been revoked and must not be relied on.", official: "Official transcript", unofficial: "Unofficial copy (for reference only)",
    docNo: "Document no.", issued: "Issued", institution: "Institution", student: "Student", studentNo: "Student no.", major: "Major", campus: "Campus", gpa: "Cumulative GPA", credits: "Credits earned", fingerprint: "Fingerprint", revokedOn: "Revoked on",
    note: "These are the facts recorded when the document was issued. Compare the fingerprint with the one printed on the document.", legacy: "This document was issued before online verification existed. We can confirm it exists, but no details were recorded.",
  },
  zh: {
    title: "成绩单验真", notFound: "没有找到和这个链接对应的成绩单。请确认二维码扫全了，或请学生重新提供。", tooMany: "尝试次数太多，请一分钟后再试。", unavailable: "服务暂时不可用。",
    valid: "这份文档确为本机构签发。", revoked: "这份文档已被作废，请勿采信。", official: "正式成绩单", unofficial: "非正式副本（仅供参考）",
    docNo: "文档编号", issued: "签发日期", institution: "机构", student: "学生", studentNo: "学号", major: "专业", campus: "校区", gpa: "累计 GPA", credits: "已获学分", fingerprint: "内容指纹", revokedOn: "作废日期",
    note: "以下是文档签发当时记录的信息。请把内容指纹和文档上印的指纹对照。", legacy: "这份文档签发时还没有在线验真功能，只能确认它存在，没有记录详细信息。",
  },
} as const;

export default async function VerifyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const h = await headers();
  const t = (h.get("accept-language") ?? "").toLowerCase().startsWith("zh") ? TEXT.zh : TEXT.en;
  let result: Verified | null = null;
  let problem: string | null = null;
  try {
    const res = await callApi({ apiUrl: webAuthConfig().apiUrl, host: h.get("host") ?? "", method: "GET", path: `/api/public/transcripts/${encodeURIComponent(token)}`, clientIp: h.get("x-forwarded-for") ?? undefined, userAgent: h.get("user-agent") ?? undefined });
    if (res.status === 200) result = JSON.parse(res.body.toString("utf8")) as Verified;
    else problem = res.status === 429 ? t.tooMany : res.status === 404 ? t.notFound : t.unavailable;
  } catch {
    problem = t.unavailable;
  }
  const row = (label: string, value: string | number | null | undefined) => (value === null || value === undefined || value === "" ? null : (
    <div className="flex gap-3 py-1"><dt className="w-32 shrink-0 text-muted">{label}</dt><dd className="font-medium">{value}</dd></div>
  ));
  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <h1 className="mb-4 text-xl font-semibold">{t.title}</h1>
      {problem ? <p role="alert">{problem}</p> : null}
      {result ? (
        <>
          <p role="status" className={`mb-4 rounded-md border px-3 py-2 ${result.status === "valid" ? "border-green-600" : "border-red-600"}`}>{result.status === "valid" ? t.valid : t.revoked}</p>
          <dl>
            {row(t.docNo, result.docNumber)}
            {row("", result.official ? t.official : t.unofficial)}
            {row(t.issued, result.issuedAt.slice(0, 10))}
            {result.revokedAt ? row(t.revokedOn, result.revokedAt.slice(0, 10)) : null}
            {row(t.institution, result.details?.institution)}
            {row(t.student, result.details?.studentName)}
            {row(t.studentNo, result.details?.studentNo)}
            {row(t.major, result.details?.major)}
            {row(t.campus, result.details?.campus)}
            {result.details ? row(t.gpa, result.details.cumulativeGpa === null ? "-" : result.details.cumulativeGpa.toFixed(2)) : null}
            {result.details ? row(t.credits, `${result.details.creditsEarned} / ${result.details.creditsAttempted}`) : null}
            {row(t.fingerprint, result.fingerprint)}
          </dl>
          <p className="mt-4 text-sm text-muted">{result.details ? t.note : t.legacy}</p>
        </>
      ) : null}
    </main>
  );
}
