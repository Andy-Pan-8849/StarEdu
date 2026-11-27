"use client";

// 班级名单里"+"打开的窗口：按姓名或学号搜索学生（每次最多取 20 个，不会一次把全部学生取出来），勾选后加入班级。
// 超员、先修课没满足、时间冲突这类要确认的情况，和以前一样：先提示，填原因后再确认。
import { useTranslations } from "next-intl";
import * as React from "react";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { bff } from "@/lib/bff";
import { Modal } from "../modal";
import { DataTable, type Column } from "../data-table";
import { PermButton } from "../permissions";
import { useTable } from "./use-table";

export const STUDENT_PICK_LIMIT = 20;
interface StudentHit { id: string; fullName: string; studentNo: string | null; campusName: string | null }
const input = "rounded-md border border-border bg-transparent px-2 py-1";

export function StudentPicker({ sectionId, exclude, onChanged, onClose }: { sectionId: string; exclude: string[]; onChanged: () => void; onClose: () => void }) {
  const t = useTranslations("pages.edu");
  const tbl = useTable();
  const [q, setQ] = React.useState("");
  const [rows, setRows] = React.useState<StudentHit[] | null>(null);
  const [picked, setPicked] = React.useState<StudentHit[]>([]); // 跨搜索保留
  const [reason, setReason] = React.useState("");
  const [needs, setNeeds] = React.useState<string[] | null>(null);
  const [issues, setIssues] = React.useState<Array<{ studentId: string; violations: string[]; detail?: { prerequisite?: string[] } }>>([]);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void bff<StudentHit[]>(`students?size=${STUDENT_PICK_LIMIT}&status=enrolled${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`).then((r) => { if (live) setRows(r); }).catch(() => { if (live) setRows([]); });
    }, q ? 250 : 0); // 打字时稍等一下再查
    return () => { live = false; clearTimeout(timer); };
  }, [q]);

  async function enroll(confirm?: string[]) {
    setBusy(true);
    try {
      const r = await bff<{ results: Array<{ studentId: string; ok: boolean; code?: string; violations?: string[]; detail?: { prerequisite?: string[] }; message?: string }> }>(`sections/${sectionId}/enrollments`, { method: "POST", body: { studentIds: picked.map((p) => p.id), confirm, reason: reason || undefined } });
      const asking = r.results.filter((x) => x.code === "CONFIRMATION_REQUIRED");
      const need = [...new Set(asking.flatMap((x) => x.violations ?? []))];
      const failed = r.results.filter((x) => !x.ok && x.code !== "CONFIRMATION_REQUIRED").map((x) => x.message).filter(Boolean);
      setNeeds(need.length ? need : null);
      setIssues(asking.map((x) => ({ studentId: x.studentId, violations: x.violations ?? [], detail: x.detail })));
      setMsg(failed.length ? failed.join("; ") : null);
      onChanged();
      if (!need.length && !failed.length) onClose();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const shown = (rows ?? []).filter((r) => !exclude.includes(r.id));
  const cols: Column<StudentHit>[] = [
    { key: "pick", header: "", cell: (r) => <input type="checkbox" aria-label={r.fullName} checked={picked.some((p) => p.id === r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r] : picked.filter((x) => x.id !== r.id))} /> },
    { key: "no", header: t("studentNo"), cell: (r) => r.studentNo ?? "" },
    { key: "name", header: t("name"), cell: (r) => r.fullName },
    { key: "campus", header: t("campus"), cell: (r) => r.campusName ?? "" },
  ];
  return (
    <Modal wide title={t("addStudents")} onClose={onClose}>
      <div className="flex h-[calc(88vh-9rem)] flex-col gap-3 text-sm">
        <input aria-label={t("searchStudents")} placeholder={t("searchStudents")} className={`${input} w-full shrink-0`} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DataTable columns={cols} rows={shown} rowKey={(r) => r.id} loading={rows === null} emptyText={t("noStudentMatches")} loadingText={tbl.loading} selectable={false} labels={tbl.labels} />
          {rows && rows.length >= STUDENT_PICK_LIMIT ? <p className="mt-2 text-xs text-muted">{t("studentSearchHint", { n: STUDENT_PICK_LIMIT })}</p> : null}
        </div>
        <div className="shrink-0 space-y-2">
          {needs ? (
            <div role="alert" className="rounded-md border border-amber-400 p-2">
              <p className="font-medium text-red-600">{t("needConfirm", { list: needs.map((n) => t(`viol_${n}`)).join(", ") })}</p>
              <ul className="mt-1 list-disc pl-5">
                {issues.map((i) => (
                  <li key={i.studentId}>{picked.find((p) => p.id === i.studentId)?.fullName ?? i.studentId}: {i.violations.map((v) => `${t(`viol_${v}`)}${v === "prerequisite" && i.detail?.prerequisite?.length ? ` (${i.detail.prerequisite.join(", ")})` : ""}`).join("; ")}</li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted">{t("overrideHelp")}</p>
              <label className="mt-1 flex flex-col gap-1">{t("reason")}<input className={input} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            </div>
          ) : null}
          {msg ? <p role="alert" className="text-red-600">{msg}</p> : null}
          <div className="flex items-center gap-2 border-t border-border pt-3">
            <PermButton perm={PERMS.eduEnrollmentAdd} size="sm" disabled={busy || picked.length === 0 || (needs !== null && !reason.trim())} onClick={() => void enroll(needs ?? undefined)}>{needs ? t("confirmEnroll") : t("enroll")}</PermButton>
            <span className="text-muted">{t("pickedCount", { n: picked.length })}</span>
            <Button size="sm" variant="outline" onClick={onClose}>{t("cancelPick")}</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
