"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { RowAction } from "../icon-button";
import { Pin, PinOff, RotateCcw } from "lucide-react";
import { PERMS } from "@staredu/shared";
import { Button } from "@/components/ui/button";
import { Can } from "../permissions";
import { bff } from "@/lib/bff";
import { useList } from "./use-api";
import { useTable } from "./use-table";
import { DataTable, type Column } from "../data-table";

interface Author { personId: string; name: string | null; role: string }
interface Thread { unread?: boolean; id: string; title: string; body: string; author: Author; pinned: boolean; resolved: boolean; createdAt: string; replyCount: number; canDelete: boolean; canResolve: boolean; canPin: boolean; canReply: boolean }
interface Reply { id: string; body: string; author: Author; createdAt: string; canDelete: boolean }
interface Detail extends Thread { replies: Reply[] }
const input = "rounded-md border border-border bg-transparent px-2 py-1";

const who = (a: Author, instructorLabel: string) => `${a.name ?? ""}${a.role === "instructor" ? ` (${instructorLabel})` : ""}`;

/** 标题前的"未读"小圆点（给读屏的文字也带上）。 */
function UnreadDot({ label }: { label: string }) {
  return <span role="img" aria-label={label} title={label} className="mr-1.5 inline-block h-2 w-2 rounded-full bg-primary align-middle" />;
}

/** 一个讨论帖的详情：回复、置顶、标记已解决、删除。打开这个帖子就算读过（服务端记）。 */
function ThreadDetail({ base, id, onBack }: { base: string; id: string; onBack: () => void }) {
  const t = useTranslations("pages.discussion");
  const [open, setOpen] = React.useState<Detail | null>(null);
  const [reply, setReply] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const show = React.useCallback((tid: string) => bff<Detail>(`${base}/${tid}`).then(setOpen), [base]);
  React.useEffect(() => { void show(id).catch((e: Error) => setErr(e.message)); }, [id, show]);
  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    try { setErr(null); await fn(); after?.(); } catch (e) { setErr((e as Error).message); }
  };
  const name = (a: Author) => who(a, t("instructor"));
  if (!open) return <div className="text-sm">{err ? <p role="alert" className="text-red-600">{err}</p> : <p className="text-muted">…</p>}</div>;
  return (
    <div className="text-sm">
      {err ? <p role="alert" className="mb-2 text-red-600">{err}</p> : null}
      <Button size="sm" variant="outline" className="mb-2" onClick={onBack}>{t("back")}</Button>
      <h3 className="font-medium">{open.pinned ? "📌 " : ""}{open.title}{open.resolved ? ` ✔ ${t("resolved")}` : ""}</h3>
      <p className="text-muted">{name(open.author)} · {new Date(open.createdAt).toLocaleString()}</p>
      <p className="mb-2 whitespace-pre-wrap">{open.body}</p>
      <div className="mb-2 flex gap-2">
        {open.canPin ? <RowAction onClick={() => void act(() => bff(`${base}/${open.id}/pin`, { method: "POST", body: { pinned: !open.pinned } }), () => void show(open.id))} icon={PinOff}>{open.pinned ? t("unpin") : t("pin")}</RowAction> : null}
        {open.canResolve ? <RowAction onClick={() => void act(() => bff(`${base}/${open.id}/resolve`, { method: "POST", body: { resolved: !open.resolved } }), () => void show(open.id))} icon={RotateCcw}>{open.resolved ? t("reopen") : t("markResolved")}</RowAction> : null}
        {open.canDelete ? <Button size="sm" variant="outline" onClick={() => window.confirm(t("confirmDelete")) && void act(() => bff(`${base}/${open.id}`, { method: "DELETE" }), onBack)}>{t("delete")}</Button> : null}
      </div>
      <ul className="mb-2 space-y-2">
        {open.replies.map((r) => (
          <li key={r.id} className="rounded-md border border-border p-2">
            <div className="text-muted">{name(r.author)} · {new Date(r.createdAt).toLocaleString()}</div>
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

/** 发新帖（要有"发帖"权限才显示）。 */
function NewPostForm({ base, onPosted }: { base: string; onPosted: () => void }) {
  const t = useTranslations("pages.discussion");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const submit = async () => {
    try { setErr(null); await bff(base, { method: "POST", body: { title, body } }); setTitle(""); setBody(""); onPosted(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Can any={[PERMS.eduDiscussionEdit, PERMS.portalDiscussionPost]}>
      {err ? <p role="alert" className="mb-2 text-red-600">{err}</p> : null}
      <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h4 className="font-medium">{t("newPost")}</h4>
        <input aria-label={t("titleField")} placeholder={t("titleField")} className={input} value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea aria-label={t("bodyField")} placeholder={t("bodyField")} className={input} rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        <Button type="submit" size="sm" disabled={!title.trim() || !body.trim()}>{t("post")}</Button>
      </form>
    </Can>
  );
}

/** 班级讨论面板：管理后台（任课教师、教务）和学生门户共用，两边路径形状相同，按钮显示由服务端给的 canXxx 决定。 */
export function DiscussionPanel({ sectionId }: { sectionId: string }) {
  const t = useTranslations("pages.discussion");
  const tbl = useTable();
  const base = `sections/${sectionId}/discussions`;
  const list = useList<Thread>(base);
  const [openId, setOpenId] = React.useState<string | null>(null);
  if (openId) return <ThreadDetail base={base} id={openId} onBack={() => { setOpenId(null); list.reload(); }} />;
  return (
    <div className="text-sm">
      <div className="mb-3">
        <DataTable
          columns={[
            { key: "title", header: t("colTitle"), cell: (th) => <button type="button" className={`text-primary hover:underline ${th.unread ? "font-semibold" : "font-medium"}`} onClick={() => setOpenId(th.id)}>{th.unread ? <UnreadDot label={t("unread")} /> : null}{th.pinned ? <Pin aria-hidden className="mr-1 inline h-3.5 w-3.5" /> : null}{th.title}</button> },
            { key: "author", header: t("colAuthor"), cell: (th) => who(th.author, t("instructor")) },
            { key: "replies", header: t("colReplies"), cell: (th) => th.replyCount },
            { key: "state", header: t("colState"), cell: (th) => (th.resolved ? <span className="text-green-700">{t("resolved")}</span> : "—") },
          ] as Column<Thread>[]}
          rows={list.rows}
          rowKey={(th) => th.id}
          loading={list.loading}
          emptyText={t("empty")}
          loadingText={tbl.loading}
          selectable={false}
          labels={tbl.labels}
        />
      </div>
      <NewPostForm base={base} onPosted={list.reload} />
    </div>
  );
}

interface AllThread { id: string; section: { id: string; name: string }; title: string; author: Author; pinned: boolean; resolved: boolean; replyCount: number; lastActivityAt: string; unread: boolean }
interface AllDiscussions { unread: number; sections: Array<{ id: string; name: string; unread: number }>; threads: AllThread[] }

/**
 * 学生的"讨论"页：默认看我所有班级的讨论，未读的排在最前，每条带"班级"列；
 * 上方可以选一个班级，只看这个班级的讨论（并在下面发新帖）。
 */
export function PortalDiscussionsPage() {
  const t = useTranslations("pages.discussion");
  const tbl = useTable();
  const [data, setData] = React.useState<AllDiscussions | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [sectionId, setSectionId] = React.useState(""); // "" = 全部
  const [open, setOpen] = React.useState<{ sectionId: string; id: string } | null>(null);
  const load = React.useCallback(() => { bff<AllDiscussions>("discussions").then((d) => { setData(d); setError(null); }).catch((e: Error) => setError(e.message)); }, []);
  React.useEffect(load, [load]);
  if (open) return (
    <section className="text-sm">
      <h2 className="mb-3 text-lg font-semibold">{t("title")}</h2>
      <ThreadDetail base={`sections/${open.sectionId}/discussions`} id={open.id} onBack={() => { setOpen(null); load(); }} />
    </section>
  );
  const rows = (data?.threads ?? []).filter((th) => !sectionId || th.section.id === sectionId);
  const label = (name: string, unread: number) => (unread > 0 ? `${name} (${t("unreadN", { n: unread })})` : name);
  return (
    <section className="text-sm">
      <h2 className="mb-3 text-lg font-semibold">{t("title")}</h2>
      {error ? <p role="alert" className="mb-2 text-red-600">{error}</p> : null}
      <select aria-label={t("pickSection")} className={`${input} mb-3`} value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
        <option value="">{label(t("allSections"), data?.unread ?? 0)}</option>
        {(data?.sections ?? []).map((x) => <option key={x.id} value={x.id}>{label(x.name, x.unread)}</option>)}
      </select>
      <div className="mb-3">
        <DataTable
          columns={[
            { key: "title", header: t("colTitle"), cell: (th) => <button type="button" className={`text-left text-primary hover:underline ${th.unread ? "font-semibold" : "font-medium"}`} onClick={() => setOpen({ sectionId: th.section.id, id: th.id })}>{th.unread ? <UnreadDot label={t("unread")} /> : null}{th.pinned ? <Pin aria-hidden className="mr-1 inline h-3.5 w-3.5" /> : null}{th.title}</button> },
            { key: "section", header: t("colSection"), cell: (th) => th.section.name },
            { key: "author", header: t("colAuthor"), cell: (th) => who(th.author, t("instructor")) },
            { key: "replies", header: t("colReplies"), cell: (th) => th.replyCount },
            { key: "last", header: t("colLast"), cell: (th) => new Date(th.lastActivityAt).toLocaleString() },
            { key: "state", header: t("colState"), cell: (th) => (th.resolved ? <span className="text-green-700">{t("resolved")}</span> : "—") },
          ] as Column<AllThread>[]}
          rows={rows}
          rowKey={(th) => th.id}
          loading={data === null && !error}
          emptyText={t("empty")}
          loadingText={tbl.loading}
          selectable={false}
          labels={tbl.labels}
        />
      </div>
      {sectionId ? <NewPostForm base={`sections/${sectionId}/discussions`} onPosted={load} /> : <p className="text-muted">{t("pickToPost")}</p>}
    </section>
  );
}
