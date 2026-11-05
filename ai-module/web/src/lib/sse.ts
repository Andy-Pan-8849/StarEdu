/**
 * 文件：lib/sse.ts
 * 作用：读取服务器推送事件（SSE, text/event-stream）的响应体，一个个吐出事件。
 * 主要思想：响应是分块到达的，块的边界不一定落在事件边界上，所以先缓冲，遇到空行（\n\n）
 *   才切出一个事件；
 * 以冒号开头的行是注释（心跳 keepalive），自动忽略；事件由 event: 名字 和 data: JSON 组成。
 * 连接结束时把缓冲区里剩下的也解析出来。
 */

/**
 * 一个事件：名字（如 message.delta）和解析后的数据。
 */
export type RunEvent = { name: string; data: Record<string, unknown> };

/**
 * 异步生成器：把 SSE 响应体切成事件逐个产出，注释行（心跳）被跳过。
 */
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

/**
 * 解析一个事件块（若干行）。没有 event 名或 data 不是合法 JSON 就返回 null 忽略。
 */
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
