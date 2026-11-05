/**
 * 文件：lib/citations.ts
 * 作用：把回答文字切成“普通文字”和“[n] 引用标记”，让引用标记可以显示成可点击的按钮。
 * 安全：文字永远当纯文本处理，绝不当 HTML 渲染（防 XSS）。只有真实存在的引用编号才会变成按钮。
 */

/**
 * 切分后的片段：一段文字，或一个引用编号。
 */
export type Part = { type: "text"; text: string } | { type: "cite"; n: number };

/**
 * 按 [n] 切分回答。参数：content 回答文字；known 真实存在的引用编号集合（不在其中的 [n]
 *   保持为普通文字）。返回片段列表。
 */
export function splitCitations(content: string, known: ReadonlySet<number>): Part[] {
  const parts: Part[] = [];
  const marker = /\[(\d+)\]/g;
  let last = 0;
  for (const match of content.matchAll(marker)) {
    const n = Number(match[1]);
    const start = match.index ?? 0;
    if (!known.has(n)) continue;
    if (start > last) parts.push({ type: "text", text: content.slice(last, start) });
    parts.push({ type: "cite", n });
    last = start + match[0].length;
  }
  if (last < content.length) parts.push({ type: "text", text: content.slice(last) });
  return parts;
}
