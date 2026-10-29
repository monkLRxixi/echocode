/**
 * Offline stand-in for all three wire formats:
 *   POST /v1/messages        Anthropic Messages     (SSE content_block_*)
 *   POST /chat/completions   OpenAI Chat Completions (SSE choices[].delta)
 *   POST /responses          OpenAI Responses        (SSE response.* events)
 *
 * It simulates exactly one tool call per turn so `--mock` exercises the whole
 * loop: stream -> tool -> result -> continue.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

const FIXTURE = `terminal green on black,
a cursor blinks and waits—
nothing compiles yet
`;

export type MockFormat = "anthropic" | "chat" | "responses";

export interface MockHandle {
  baseUrl: string;
  close(): Promise<void>;
}

interface Plan {
  text?: string;
  tool?: { name: string; input: Record<string, unknown> };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function plan(hasResult: boolean, prompt: string, resultText: string): Plan {
  if (hasResult) {
    const first = resultText.split("\n").find((l) => l.trim()) ?? "done";
    return {
      text:
        `Done. ${first}\n\n` +
        `That was the tool loop: I asked for a tool, the harness ran it, the result came back, ` +
        `and the model continued.`,
    };
  }

  const p = prompt.toLowerCase();
  if (/(create|write|新建|创建|写).*(file|文件|hello)|hello\.txt/.test(p)) {
    return { text: "Writing the file, then I'll confirm the bytes on disk.", tool: { name: "Write", input: { file_path: "hello.txt", content: FIXTURE } } };
  }
  if (/(run|exec|bash|command|ls|运行|执行)/.test(p)) {
    return { tool: { name: "Bash", input: { command: "ls -la", description: "list files" } } };
  }
  if (/(read|open|读取|打开)/.test(p)) {
    return { tool: { name: "Read", input: { file_path: "hello.txt" } } };
  }
  if (/(edit|change|修改|改)/.test(p)) {
    return { tool: { name: "Edit", input: { file_path: "hello.txt", old_string: "green", new_string: "bright green" } } };
  }
  return {
    text:
      "I'm the offline mock, so this reply is canned — but the plumbing around it is real: SSE streaming, " +
      'the tool loop, permissions and the session log.\n\nTry: `create a file called hello.txt`, `run ls`, ' +
      "`read hello.txt`, `edit hello.txt`.",
  };
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

function sse(res: http.ServerResponse, event: string | null, data: unknown): void {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

function pieces(text: string, size: number): string[] {
  const out: string[] = [];
  let buf = "";
  for (const word of text.split(/(?<=\s)/)) {
    if (word.length > size * 3) {
      for (let i = 0; i < word.length; i += size) out.push(word.slice(i, i + size));
      continue;
    }
    if (buf.length + word.length > size) {
      if (buf) out.push(buf);
      buf = word;
    } else buf += word;
  }
  if (buf) out.push(buf);
  return out.length ? out : [""];
}

/* ---------------------------- Anthropic ---------------------------- */

function inspectAnthropic(body: any) {
  const msgs: any[] = body.messages ?? [];
  const last = msgs[msgs.length - 1];
  const content = Array.isArray(last?.content) ? last.content : [];
  const result = content.find((b: any) => b?.type === "tool_result");
  let prompt = "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    const t = (Array.isArray(m.content) ? m.content : [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("\n");
    if (t) {
      prompt = t;
      break;
    }
  }
  const resultText = result
    ? typeof result.content === "string"
      ? result.content
      : (Array.isArray(result.content) ? result.content : []).map((b: any) => b?.text ?? "").join("\n")
    : "";
  return { hasResult: !!result, prompt, resultText };
}

async function serveAnthropic(res: http.ServerResponse, body: any) {
  const { hasResult, prompt, resultText } = inspectAnthropic(body);
  const p = plan(hasResult, prompt, resultText);
  const model = body.model ?? "mock-anthropic";

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  sse(res, null, {
    type: "message_start",
    message: {
      id: `msg_mock_${Math.random().toString(36).slice(2, 10)}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1200, output_tokens: 0, cache_read_input_tokens: 800 },
    },
  });

  let idx = 0;
  if (p.text) {
    sse(res, null, { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
    for (const piece of pieces(p.text, 24)) {
      await sleep(10);
      sse(res, null, { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: piece } });
    }
    sse(res, null, { type: "content_block_stop", index: idx });
    idx++;
  }

  if (p.tool) {
    const id = `toolu_mock_${Math.random().toString(36).slice(2, 10)}`;
    sse(res, null, {
      type: "content_block_start",
      index: idx,
      content_block: { type: "tool_use", id, name: p.tool.name, input: {} },
    });
    for (const piece of pieces(JSON.stringify(p.tool.input), 18)) {
      await sleep(8);
      sse(res, null, { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: piece } });
    }
    sse(res, null, { type: "content_block_stop", index: idx });
  }

  await sleep(15);
  sse(res, null, {
    type: "message_delta",
    delta: { stop_reason: p.tool ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 96 },
  });
  sse(res, null, { type: "message_stop" });
  res.end();
}

/* ------------------------- OpenAI chat ---------------------------- */

function inspectChat(body: any) {
  const msgs: any[] = body.messages ?? [];
  const last = msgs[msgs.length - 1];
  const hasResult = last?.role === "tool";
  let prompt = "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    prompt = typeof m.content === "string" ? m.content : "";
    if (prompt) break;
  }
  return { hasResult, prompt, resultText: hasResult ? String(last.content ?? "") : "" };
}

async function serveChat(res: http.ServerResponse, body: any) {
  const { hasResult, prompt, resultText } = inspectChat(body);
  const p = plan(hasResult, prompt, resultText);
  const model = body.model ?? "mock-chat";
  const id = `chatcmpl_mock_${Math.random().toString(36).slice(2, 10)}`;

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const chunk = (delta: unknown, finish: string | null = null) =>
    sse(res, null, {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });

  chunk({ role: "assistant", content: "" });
  if (p.text) {
    for (const piece of pieces(p.text, 24)) {
      await sleep(10);
      chunk({ content: piece });
    }
  }
  if (p.tool) {
    const callId = `call_mock_${Math.random().toString(36).slice(2, 10)}`;
    chunk({ tool_calls: [{ index: 0, id: callId, type: "function", function: { name: p.tool.name, arguments: "" } }] });
    for (const piece of pieces(JSON.stringify(p.tool.input), 18)) {
      await sleep(8);
      chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] });
    }
  }
  await sleep(15);
  chunk({}, p.tool ? "tool_calls" : "stop");
  sse(res, null, {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage: { prompt_tokens: 1200, completion_tokens: 96, total_tokens: 1296 },
  });
  sse(res, null, "[DONE]");
  res.end();
}

/* ----------------------- OpenAI responses ------------------------- */

function inspectResponses(body: any) {
  const input: any[] = body.input ?? [];
  const last = input[input.length - 1];
  const hasResult = last?.type === "function_call_output";
  let prompt = "";
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item.type || item.role !== "user") continue;
    prompt = (Array.isArray(item.content) ? item.content : [])
      .filter((c: any) => c?.type === "input_text")
      .map((c: any) => c.text)
      .join("\n");
    if (prompt) break;
  }
  return { hasResult, prompt, resultText: hasResult ? String(last.output ?? "") : "" };
}

async function serveResponses(res: http.ServerResponse, body: any) {
  const { hasResult, prompt, resultText } = inspectResponses(body);
  const p = plan(hasResult, prompt, resultText);
  const model = body.model ?? "mock-responses";
  const responseId = `resp_mock_${Math.random().toString(36).slice(2, 10)}`;

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  sse(res, "response.created", {
    type: "response.created",
    response: { id: responseId, object: "response", model, status: "in_progress", output: [] },
  });

  const output: any[] = [];
  if (p.text) {
    const msgId = `msg_mock_${Math.random().toString(36).slice(2, 8)}`;
    output.push({ type: "message", id: msgId, role: "assistant", content: [{ type: "output_text", text: p.text }] });
    for (const piece of pieces(p.text, 24)) {
      await sleep(10);
      sse(res, "response.output_text.delta", { type: "response.output_text.delta", item_id: msgId, delta: piece });
    }
  }

  if (p.tool) {
    const itemId = `fc_mock_${Math.random().toString(36).slice(2, 8)}`;
    const callId = `call_mock_${Math.random().toString(36).slice(2, 10)}`;
    const args = JSON.stringify(p.tool.input);
    sse(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: output.length,
      item: { type: "function_call", id: itemId, call_id: callId, name: p.tool.name, arguments: "" },
    });
    for (const piece of pieces(args, 18)) {
      await sleep(8);
      sse(res, "response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: itemId,
        delta: piece,
      });
    }
    sse(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: output.length,
      item: { type: "function_call", id: itemId, call_id: callId, name: p.tool.name, arguments: args },
    });
    output.push({ type: "function_call", id: itemId, call_id: callId, name: p.tool.name, arguments: args });
  }

  await sleep(15);
  sse(res, "response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      model,
      status: "completed",
      output,
      usage: { input_tokens: 1200, output_tokens: 96, total_tokens: 1296 },
    },
  });
  res.end();
}

/* ------------------------------- server --------------------------- */

export async function startMock(opts: { port?: number } = {}): Promise<MockHandle> {
  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    if (req.method === "GET" && (url === "/" || url === "/health")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, mock: true }));
      return;
    }

    const body = await readBody(req);
    if (!body) {
      res.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"bad json"}}');
      return;
    }

    try {
      if (url === "/v1/messages") return await serveAnthropic(res, body);
      if (url.endsWith("/chat/completions")) return await serveChat(res, body);
      if (url.endsWith("/responses")) return await serveResponses(res, body);
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":{"message":"unknown endpoint"}}');
    } catch (err: any) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: err?.message ?? "mock failure" } }));
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
