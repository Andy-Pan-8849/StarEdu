/** Splits an answer into plain text and [n] markers, so markers can become buttons.
 * The text is never treated as HTML. */
export type Part = { type: "text"; text: string } | { type: "cite"; n: number };

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
