export interface SseFrame {
  event?: string;
  data: string;
}

/**
 * Minimal SSE reader: handles both `event:` + `data:` frames and bare `data:`
 * frames, tolerates CRLF and multi-line data, and ignores keep-alive comments.
 */
export async function* sseFrames(res: Response): AsyncGenerator<SseFrame> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }
    const tail = parseFrame(buf);
    if (tail) yield tail;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!data.length) return null;
  return { event, data: data.join("\n") };
}

export function parseJson<T = unknown>(data: string): T | null {
  if (data === "[DONE]") return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
