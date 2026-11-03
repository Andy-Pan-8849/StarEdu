"use client";

import { splitCitations } from "@/lib/citations";
import type { Citation } from "@/lib/types";

/** An answer as plain text, with each [n] that matches a citation turned into a button. */
export function MessageBody({
  content,
  citations,
  onCite,
}: {
  content: string;
  citations: Citation[];
  onCite: (citation: Citation) => void;
}) {
  const byNumber = new Map(citations.map((c) => [c.n, c]));
  const parts = splitCitations(content, new Set(byNumber.keys()));
  return (
    <p className="whitespace-pre-wrap break-words">
      {parts.map((part, index) => {
        if (part.type === "text") return <span key={index}>{part.text}</span>;
        const citation = byNumber.get(part.n);
        return (
          <button
            key={index}
            type="button"
            className="mx-0.5 rounded bg-indigo-50 px-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
            aria-label={`Show source ${part.n}`}
            onClick={() => citation && onCite(citation)}
          >
            [{part.n}]
          </button>
        );
      })}
    </p>
  );
}
