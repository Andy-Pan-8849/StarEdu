"use client";

/**
 * 文件：components/message-body.tsx
 * 作用：显示一条回答：纯文本，其中的 [n] 引用标记变成可点击按钮，点击打开对应来源。
 * 安全：文字以纯文本渲染（不是 HTML），模型输出里的任何标签都不会被执行。
 */

import { splitCitations } from "@/lib/citations";
import type { Citation } from "@/lib/types";

/**
 * 把回答渲染成文字 + 引用按钮。参数：content 回答；citations 引用列表；onCite 点击引用的回调。
 */
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
