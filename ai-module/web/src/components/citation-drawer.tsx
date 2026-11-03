"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth-provider";
import { Badge, Button } from "@/components/ui";
import { userMessage } from "@/lib/api";
import type { ChunksResponse, Citation } from "@/lib/types";
import { cn } from "@/lib/utils";

export function CitationDrawer({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  return (
    <aside
      role="complementary"
      aria-label="Source"
      className="flex h-full w-full max-w-md flex-col border-l border-slate-200 bg-white"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Source [{citation.n}]</h2>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close source">
          ✕
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
        {citation.kind === "data" ? (
          <DataSource views={citation.views} rows={citation.row_count} />
        ) : (
          <DocumentSource citation={citation} />
        )}
      </div>
    </aside>
  );
}

function DataSource({ views, rows }: { views: string[]; rows: number }) {
  return (
    <div className="space-y-2">
      <p className="text-slate-700">This answer comes from business data.</p>
      <p>
        Data: <strong>{views.join(", ")}</strong>
      </p>
      <p>
        Rows used: <strong>{rows}</strong>
      </p>
      <p className="text-xs text-slate-500">Only data your account may see is ever included.</p>
    </div>
  );
}

function DocumentSource({ citation }: { citation: Extract<Citation, { kind: "document" }> }) {
  const { api } = useAuth();
  const [data, setData] = useState<ChunksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    if (!citation.document_id) {
      setError("The original text is not available for this answer.");
      return;
    }
    api
      .json<ChunksResponse>(
        `/documents/${citation.document_id}/chunks?around=${citation.chunk_id}&window=1`,
      )
      .then((response) => {
        if (!cancelled) setData(response);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(userMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [api, citation.document_id, citation.chunk_id]);

  async function openOriginal() {
    if (!citation.document_id) return;
    try {
      const file = await api.blob(`/documents/${citation.document_id}/file`);
      window.open(URL.createObjectURL(file), "_blank", "noopener");
    } catch (e) {
      setError(userMessage(e));
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="font-medium text-slate-900">{citation.title}</p>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span>{citation.doc_code}</span>
          <span>v{citation.version}</span>
          <Badge tone={citation.status === "active" ? "green" : "amber"}>{citation.status}</Badge>
          {citation.page ? <span>page {citation.page}</span> : null}
        </p>
        {citation.heading_path.length > 0 ? (
          <p className="mt-1 text-xs text-slate-500">{citation.heading_path.join(" › ")}</p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      ) : null}
      {!data && !error ? <p className="text-slate-500">Loading…</p> : null}
      {data?.chunks.map((chunk) => (
        <div
          key={chunk.id}
          data-cited={chunk.id === citation.chunk_id}
          className={cn(
            "whitespace-pre-wrap rounded-md border p-3 text-slate-800",
            chunk.id === citation.chunk_id ? "border-indigo-300 bg-indigo-50" : "border-slate-200",
          )}
        >
          {chunk.text}
        </div>
      ))}
      {citation.document_id ? (
        <Button variant="secondary" size="sm" onClick={openOriginal}>
          Open the original file
        </Button>
      ) : null}
    </div>
  );
}
