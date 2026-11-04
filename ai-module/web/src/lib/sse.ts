export type RunEvent = { name: string; data: Record<string, unknown> };

/** Splits a text/event-stream body into events. Comment lines (keepalives) are skipped. */
export async function* readEvents(response: Response): AsyncGenerator<RunEvent> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const event = parseBlock(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (event) yield event;
      end = buffer.indexOf("\n\n");
    }
    if (done) {
      const last = parseBlock(buffer);
      if (last) yield last;
      return;
    }
  }
}

function parseBlock(block: string): RunEvent | null {
  let name = "";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!name) return null;
  try {
    return { name, data: JSON.parse(data.join("\n")) as Record<string, unknown> };
  } catch {
    return null;
  }
}
