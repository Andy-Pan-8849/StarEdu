"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { Can } from "../permissions";
import { bff } from "@/lib/bff";
import { useList } from "./use-api";

interface Author { personId: string; name: string | null; role: string }
interface Thread { id: string; title: string; body: string; author: Author; pinned: boolean; resolved: boolean; createdAt: string; replyCount: number; canDelete: boolean; canResolve: boolean; canPin: boolean; canReply: boolean }
interface Reply { id: string; body: string; author: Author; createdAt: string; canDelete: boolean }
interface Detail extends Thread { replies: Reply[] }
const input = "rounded-md border border-border bg-transparent px-2 py-1";

/** 班级讨论面板：管理后台（任课教师、教务）和学生门户共用，两边路径形状相同，按钮显示由服务端给的 canXxx 决定。 */
export function DiscussionPanel({ sectionId }: { sectionId: string }) {
  const t = useTranslations("pages.discussion");
  const list = useList<Thread>(`sections/${sectionId}/discussions`);
  const [open, setOpen] = React.useState<Detail | null>(null);
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [reply, setReply] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const base = `sections/${sectionId}/discussions`;
  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    try { setErr(null); await fn(); list.reload(); after?.(); } catch (e) { setErr((e as Error).message); }
  };
  const show = (id: string) => bff<Detail>(`${base}/${id}`).then(setOpen);
  const who = (a: Author) => `${a.name ?? ""}${a.role === "instructor" ? ` (${t("instructor")})` : ""}`;

  if (open) {
    return (
      <div className="text-sm">
        {err ? <p role="alert" className="mb-2 text-red-600">{err}</p> : null}
        <Button size="sm" variant="outline" className="mb-2" onClick={() => { setOpen(null); list.reload(); }}>{t("back")}</Button>
        <h3 className="font-medium">{open.pinned ? "📌 " : ""}{open.title}{open.resolved ? ` ✔ ${t("resolved")}` : ""}</h3>
        <p className="text-muted">{who(open.author)} · {new Date(open.createdAt).toLocaleString()}</p>
        <p className="mb-2 whitespace-pre-wrap">{open.body}</p>
        <div className="mb-2 flex gap-2">
          {open.canPin ? <Button size="sm" variant="outline" onClick={() => void act(() => bff(`${base}/${open.id}/pin`, { method: "POST", body: { pinned: !open.pinned } }), () => void show(open.id))}>{open.pinned ? t("unpin") : t("pin")}</Button> : null}
          {open.canResolve ? <Button size="sm" variant="outline" onClick={() => void act(() => bff(`${base}/${open.id}/resolve`, { method: "POST", body: { resolved: !open.resolved } }), () => void show(open.id))}>{open.resolved ? t("reopen") : t("markResolved")}</Button> : null}
          {open.canDelete ? <Button size="sm" variant="outline" onClick={() => window.confirm(t("confirmDelete")) && void act(() => bff(`${base}/${open.id}`, { method: "DELETE" }), () => setOpen(null))}>{t("delete")}</Button> : null}
        </div>
        <ul className="mb-2 space-y-2">
          {open.replies.map((r) => (
            <li key={r.id} className="rounded-md border border-border p-2">
              <div className="text-muted">{who(r.author)} · {new Date(r.createdAt).toLocaleString()}</div>
              <div className="whitespace-pre-wrap">{r.body}</div>
              {r.canDelete ? <button type="button" className="text-xs underline" onClick={() => window.confirm(t("confirmDelete")) && void act(() => bff(`${base}/${r.id}`, { method: "DELETE" }), () => void show(open.id))}>{t("delete")}</button> : null}
            </li>
          ))}
        </ul>
        {open.canReply ? (
          <div className="flex flex-col gap-2">
            <textarea aria-label={t("yourReply")} className={input} rows={3} value={reply} onChange={(e) => setReply(e.target.value)} />
            <Button size="sm" disabled={!reply.trim()} onClick={() => void act(() => bff(`${base}/${open.id}/replies`, { method: "POST", body: { body: reply } }), () => { setReply(""); void show(open.id); })}>{t("reply")}</Button>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="text-sm">
      {err ? <p role="alert" className="mb-2 text-red-600">{err}</p> : null}
      <ul className="mb-3 space-y-1">
        {list.rows.map((th) => (
          <li key={th.id} className="rounded-md border border-border p-2">
            <button type="button" className="font-medium underline" onClick={() => void show(th.id)}>{th.pinned ? "📌 " : ""}{th.title}</button>
            {th.resolved ? <span className="ml-2 text-green-700">✔ {t("resolved")}</span> : null}
            <div className="text-muted">{who(th.author)} · {t("replies", { n: th.replyCount })}</div>
          </li>
        ))}
        {list.rows.length === 0 ? <li className="text-muted">{t("empty")}</li> : null}
      </ul>
      <Can any={[PERMS.eduDiscussionEdit, PERMS.portalDiscussionPost]}>
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void act(() => bff(base, { method: "POST", body: { title, body } }), () => { setTitle(""); setBody(""); }); }}>
          <h4 className="font-medium">{t("newPost")}</h4>
          <input aria-label={t("titleField")} placeholder={t("titleField")} className={input} value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea aria-label={t("bodyField")} placeholder={t("bodyField")} className={input} rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
          <Button type="submit" size="sm" disabled={!title.trim() || !body.trim()}>{t("post")}</Button>
        </form>
      </Can>
    </div>
  );
}

/** 学生门户：我的班级里挑一个，进入讨论。 */
export function PortalDiscussionsPage() {
  const t = useTranslations("pages.discussion");
  const mine = useList<{ id: string; status: string; section: { id: string; name: string } }>("my-enrollments");
  const [sectionId, setSectionId] = React.useState("");
  const sections = mine.rows.filter((e) => e.status === "enrolled" || e.status === "completed");
  return (
    <section className="text-sm">
      <h2 className="mb-3 text-lg font-semibold">{t("title")}</h2>
      <select aria-label={t("pickSection")} className={`${input} mb-3`} value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
        <option value="">{t("pickSection")}</option>
        {sections.map((e) => <option key={e.id} value={e.section.id}>{e.section.name}</option>)}
      </select>
      {sectionId ? <DiscussionPanel key={sectionId} sectionId={sectionId} /> : null}
    </section>
  );
}
