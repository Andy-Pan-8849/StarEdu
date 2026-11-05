"use client";

/**
 * 文件：components/chat.tsx
 * 作用：聊天界面本体：左边会话列表（新建、改名、归档），右边消息区、输入框，
 *   点引用在右侧抽屉看原文。
 * 主要思想（流式显示，最需要读懂的部分在 send 函数）：
 *   1. 发消息时请求 SSE 事件流，按事件更新界面：
 *      - message.delta：把新到的文字累加到“草稿”消息上，边写边显示；
 *      - message.retract：草稿没通过校验被撤回——清掉草稿并提示“正在重写更正后的回答”；
 *      - citations：记下引用；
 *      - run.ended：用最终回复（带消息 ID、结局、引用）替换草稿，这才是定稿；
 *      - error：抛出错误显示给用户。
 *   2. 草稿用临时 ID（draft-…）区分，定稿后换成真实消息 ID。
 *   3. 非“已回答”的结局（拒绝、没找到等）用浅灰底显示，和正常回答区分开。
 *   4. 刷新会话列表（标题由后端从首条消息生成）。
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "@/components/auth-provider";
import { CitationDrawer } from "@/components/citation-drawer";
import { MessageBody } from "@/components/message-body";
import { Button, Input } from "@/components/ui";
import { userMessage } from "@/lib/api";
import { readEvents } from "@/lib/sse";
import type { Citation, Conversation, EndState, Message, Page } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 界面上显示的消息：在 Message 之外多记结局（决定样式）和是否正在流式输出。
 */
type Shown = Message & { endState?: EndState; streaming?: boolean };

/**
 * 聊天界面。会话和消息都从 API 取；发送消息走流式接口。
 */
export function Chat() {
  const { api } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Shown[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [retracted, setRetracted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [citation, setCitation] = useState<Citation | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // 会话列表：取最近 50 个，过滤掉已归档的
  const loadConversations = useCallback(async () => {
    try {
      const page = await api.json<Page<Conversation>>("/conversations?limit=50");
      setConversations(page.items.filter((c) => !c.archived));
    } catch (e) {
      setError(userMessage(e));
    }
  }, [api]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    // 有新消息或开始发送时，滚动到底部
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [messages, sending]);

  /**
   * 打开一个已有会话：取它的消息（按时间排序）显示。
   */
  async function open(id: string) {
    setActiveId(id);
    setCitation(null);
    setError(null);
    try {
      const page = await api.json<Page<Message>>(`/conversations/${id}/messages?limit=100`);
      setMessages(
        [...page.items].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "")),
      );
    } catch (e) {
      setError(userMessage(e));
    }
  }

  /**
   * 开始新会话：清空当前选择与消息。真正的会话在第一次发送时才创建。
   */
  function startNew() {
    setActiveId(null);
    setMessages([]);
    setCitation(null);
    setError(null);
  }

  /**
   * 发送一条消息并按事件流更新界面（流程见文件头）。没有当前会话时先创建；发送中不能重复发送。
   */
  async function send(event: FormEvent) {
    event.preventDefault();
    const text_ = draft.trim();
    if (!text_ || sending) return;
    setSending(true);
    setError(null);
    try {
      // 还没有会话就先创建一个
      let id = activeId;
      if (id === null) {
        const created = await api.json<Conversation>("/conversations", { method: "POST" });
        id = created.id;
        setActiveId(id);
      }
      setMessages((m) => [
        ...m,
        { id: `local-${Date.now()}`, role: "user", content: text_, citations: [] },
      ]);
      setDraft("");
      let finalCitations: Citation[] = [];
      const draftId = `draft-${Date.now()}`;
      let text = "";
      // patch：更新草稿消息，不存在就新建一条
      const patch = (changes: Partial<Shown>) =>
        setMessages((m) =>
          m.some((x) => x.id === draftId)
            ? m.map((x) => (x.id === draftId ? { ...x, ...changes } : x))
            : [...m, { id: draftId, role: "assistant", content: "", citations: [], ...changes }],
        );
      // 发起流式请求，按事件逐个处理
      const response = await api.stream(`/conversations/${id}/messages`, { content: text_ });
      for await (const ev of readEvents(response)) {
        if (ev.name === "message.delta") {
          text += String(ev.data.text ?? "");
          setRetracted(false);
          patch({ content: text, streaming: true });
        } else if (ev.name === "message.retract") {
          // The draft failed its check: take it off the screen and say why it vanished.
          text = "";
          setRetracted(true);
          setMessages((m) => m.filter((x) => x.id !== draftId));
        } else if (ev.name === "run.ended") {
          const final: Shown = {
            id: String(ev.data.message_id),
            role: "assistant",
            content: String(ev.data.content ?? text),
            citations: finalCitations,
            endState: ev.data.end_state as EndState,
          };
          setMessages((m) => [...m.filter((x) => x.id !== draftId), final]);
          setRetracted(false);
        } else if (ev.name === "citations") {
          finalCitations = (ev.data.citations as Citation[]) ?? [];
        } else if (ev.name === "error") {
          throw new Error(String(ev.data.message ?? "error"));
        }
      }
      void loadConversations();
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setSending(false);
    }
  }

  /**
   * 给会话改名（空标题忽略）。
   */
  async function rename(id: string, title: string) {
    setRenaming(null);
    if (!title.trim()) return;
    try {
      await api.json(`/conversations/${id}`, { method: "PATCH", json: { title: title.trim() } });
      await loadConversations();
    } catch (e) {
      setError(userMessage(e));
    }
  }

  /**
   * 归档会话（隐藏，不删除），先让用户确认；归档的是当前会话就回到新会话状态。
   */
  async function archive(id: string) {
    if (!window.confirm("Archive this conversation?")) return;
    try {
      await api.json(`/conversations/${id}`, { method: "DELETE" });
      if (id === activeId) startNew();
      await loadConversations();
    } catch (e) {
      setError(userMessage(e));
    }
  }

  return (
    <div className="flex h-full">
      <nav
        aria-label="Conversations"
        className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-slate-50"
      >
        <div className="p-3">
          <Button className="w-full" onClick={startNew}>
            New conversation
          </Button>
        </div>
        <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {conversations.map((c) => (
            <li key={c.id} className="group flex items-center gap-1">
              {renaming === c.id ? (
                <Input
                  autoFocus
                  defaultValue={c.title ?? ""}
                  aria-label="Conversation title"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void rename(c.id, e.currentTarget.value);
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  onBlur={(e) => void rename(c.id, e.currentTarget.value)}
                />
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void open(c.id)}
                    className={cn(
                      "min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-200",
                      c.id === activeId && "bg-slate-200 font-medium",
                    )}
                  >
                    {c.title ?? "New conversation"}
                  </button>
                  <button
                    type="button"
                    aria-label={`Rename ${c.title ?? "conversation"}`}
                    className="invisible rounded px-1 text-xs text-slate-500 hover:bg-slate-200 group-hover:visible focus:visible"
                    onClick={() => setRenaming(c.id)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    aria-label={`Archive ${c.title ?? "conversation"}`}
                    className="invisible rounded px-1 text-xs text-slate-500 hover:bg-slate-200 group-hover:visible focus:visible"
                    onClick={() => void archive(c.id)}
                  >
                    🗑
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </nav>

      <section className="flex min-w-0 flex-1 flex-col" aria-label="Conversation">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5" aria-live="polite">
          {messages.length === 0 && !sending ? (
            <p className="mt-16 text-center text-sm text-slate-500">
              Ask about HR, finance or technical support policies, or about your own data.
            </p>
          ) : null}
          {messages.map((m) => (
            <div
              key={m.id}
              className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
            >
              <div
                data-role={m.role}
                data-end-state={m.endState}
                className={cn(
                  "max-w-2xl rounded-lg px-4 py-2.5 text-sm",
                  m.role === "user"
                    ? "bg-indigo-600 text-white"
                    : "border border-slate-200 bg-white text-slate-900",
                  m.endState && m.endState !== "answered" && "bg-slate-50 text-slate-700",
                )}
              >
                {m.role === "assistant" ? (
                  <MessageBody content={m.content} citations={m.citations} onCite={setCitation} />
                ) : (
                  <p className="whitespace-pre-wrap break-words">{m.content}</p>
                )}
              </div>
            </div>
          ))}
          {retracted ? (
            <p role="status" className="text-sm text-amber-700">
              The draft did not pass the check and was withdrawn. Writing a corrected answer…
            </p>
          ) : null}
          {sending && !messages.some((m) => m.streaming) && !retracted ? (
            <p className="text-sm text-slate-500">Thinking…</p>
          ) : null}
          <div ref={bottom} />
        </div>
        {error ? (
          <p
            role="alert"
            className="border-t border-red-200 bg-red-50 px-5 py-2 text-sm text-red-700"
          >
            {error}
          </p>
        ) : null}
        <form onSubmit={send} className="flex gap-2 border-t border-slate-200 bg-white p-4">
          <Input
            aria-label="Your question"
            placeholder="Ask a question…"
            value={draft}
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" disabled={sending || !draft.trim()}>
            Send
          </Button>
        </form>
      </section>

      {citation ? <CitationDrawer citation={citation} onClose={() => setCitation(null)} /> : null}
    </div>
  );
}
