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
  const [picked, setPicked] = React.useState<string[]>([]);
  const [reason, setReason] = React.useState("");
  const [needs, setNeeds] = React.useState<string[] | null>(null);
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
      const r = await bff<{ results: Array<{ ok: boolean; code?: string; violations?: string[]; message?: string }> }>(`sections/${sectionId}/enrollments`, { method: "POST", body: { studentIds: picked, confirm, reason: reason || undefined } });
      const need = [...new Set(r.results.flatMap((x) => (x.code === "CONFIRMATION_REQUIRED" ? (x.violations ?? []) : [])))];
      const failed = r.results.filter((x) => !x.ok && x.code !== "CONFIRMATION_REQUIRED").map((x) => x.message).filter(Boolean);
      setNeeds(need.length ? need : null);
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
    { key: "pick", header: "", cell: (r) => <input type="checkbox" aria-label={r.fullName} checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} /> },
    { key: "no", header: t("studentNo"), cell: (r) => r.studentNo ?? "" },
    { key: "name", header: t("name"), cell: (r) => r.fullName },
    { key: "campus", header: t("campus"), cell: (r) => r.campusName ?? "" },
  ];
  return (
    <Modal wide title={t("addStudents")} onClose={onClose}>
      <div className="min-h-[24rem] space-y-3 text-sm">
        <input aria-label={t("searchStudents")} placeholder={t("searchStudents")} className={`${input} w-full`} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <DataTable columns={cols} rows={shown} rowKey={(r) => r.id} loading={rows === null} emptyText={t("noStudentMatches")} loadingText={tbl.loading} selectable={false} labels={tbl.labels} />
        {rows && rows.length >= STUDENT_PICK_LIMIT ? <p className="text-xs text-muted">{t("studentSearchHint", { n: STUDENT_PICK_LIMIT })}</p> : null}
        {needs ? <p role="alert" className="text-red-600">{t("needConfirm", { list: needs.map((n) => t(`viol_${n}`)).join(", ") })}</p> : null}
        {needs ? <label className="flex flex-col gap-1">{t("reason")}<input className={input} value={reason} onChange={(e) => setReason(e.target.value)} /></label> : null}
        {msg ? <p role="alert" className="text-red-600">{msg}</p> : null}
        <div className="flex items-center gap-2 border-t border-border pt-3">
          <PermButton perm={PERMS.eduEnrollmentAdd} size="sm" disabled={busy || picked.length === 0 || (needs !== null && !reason.trim())} onClick={() => void enroll(needs ?? undefined)}>{needs ? t("confirmEnroll") : t("enroll")}</PermButton>
          <span className="text-muted">{t("pickedCount", { n: picked.length })}</span>
          <Button size="sm" variant="outline" onClick={onClose}>{t("cancelPick")}</Button>
        </div>
      </div>
    </Modal>
  );
}
