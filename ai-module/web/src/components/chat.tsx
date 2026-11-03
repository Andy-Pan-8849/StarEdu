"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "@/components/auth-provider";
import { CitationDrawer } from "@/components/citation-drawer";
import { MessageBody } from "@/components/message-body";
import { Button, Input } from "@/components/ui";
import { userMessage } from "@/lib/api";
import type { Citation, Conversation, EndState, Message, Page } from "@/lib/types";
import { cn } from "@/lib/utils";

type Shown = Message & { endState?: EndState };

type Reply = {
  message: { id: string; content: string; citations: Citation[] };
  end_state: EndState;
};

export function Chat() {
  const { api } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Shown[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [citation, setCitation] = useState<Citation | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

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
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [messages, sending]);

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

  function startNew() {
    setActiveId(null);
    setMessages([]);
    setCitation(null);
    setError(null);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      let id = activeId;
      if (id === null) {
        const created = await api.json<Conversation>("/conversations", { method: "POST" });
        id = created.id;
        setActiveId(id);
      }
      setMessages((m) => [
        ...m,
        { id: `local-${Date.now()}`, role: "user", content: text, citations: [] },
      ]);
      setDraft("");
      const reply = await api.json<Reply>(`/conversations/${id}/messages`, {
        method: "POST",
        json: { content: text },
      });
      setMessages((m) => [
        ...m,
        {
          id: reply.message.id,
          role: "assistant",
          content: reply.message.content,
          citations: reply.message.citations,
          endState: reply.end_state,
        },
      ]);
      void loadConversations();
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setSending(false);
    }
  }

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
          {sending ? <p className="text-sm text-slate-500">Thinking…</p> : null}
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
