import type {
  Provider,
  ProviderRequest,
  StreamEvent,
  Usage,
  WireMessage,
} from "../types.js";
import { parseJson, sseFrames } from "./sse.js";
import { postJson } from "./http.js";
import { parseArgs } from "./anthropic.js";

/**
 * OpenAI Chat Completions (`POST /chat/completions`, SSE `choices[].delta`).
 * Works with api.openai.com and with any OpenAI-compatible gateway
 * (vLLM, Ollama, LiteLLM, OpenRouter, Azure-style proxies, …).
 */
export const openaiChat: Provider = {
  id: "openai-chat",
  label: "openai-chat",
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-4.1",
  keyEnv: ["ECHOCODE_API_KEY", "OPENAI_API_KEY"],

  async *stream(req: ProviderRequest, o): AsyncGenerator<StreamEvent> {
    const res = await postJson(
      "/chat/completions",
      {
        model: req.model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: req.maxTokens,
        messages: toChatMessages(req),
        ...(req.tools.length
          ? {
              tools: req.tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.input_schema },
              })),
              tool_choice: "auto",
            }
          : {}),
      },
      {
        baseUrl: o.baseUrl,
        apiKey: o.apiKey,
        authToken: o.authToken,
        signal: o.signal,
        headers: o.headers ?? {},
        wantStream: true,
      },
    );

    const calls = new Map<number, { id: string; name: string; args: string }>();
    const announced = new Set<number>();
    let stop: StreamEvent | null = null;

    for await (const frame of sseFrames(res)) {
      const chunk = parseJson<any>(frame.data);
      if (!chunk) continue;

      if (chunk.error) throw new Error(`openai-chat: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);

      if (chunk.usage) yield { type: "usage", usage: toUsage(chunk.usage) };

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (typeof delta.content === "string" && delta.content) {
        yield { type: "text_delta", text: delta.content };
      }

      for (const tc of delta.tool_calls ?? []) {
        const index = Number(tc.index ?? 0);
        const fresh = !calls.has(index);
        const cur = calls.get(index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (!cur.id) cur.id = `call_${index}`;
        calls.set(index, cur);

        // The name can arrive in the same chunk as the first argument fragment,
        // so announce the call whenever a name shows up and we have not yet.
        if (cur.name && (fresh || !announced.has(index))) {
          announced.add(index);
          yield { type: "tool_start", id: cur.id, name: cur.name };
        }
        const piece: string = tc.function?.arguments ?? "";
        if (piece) {
          cur.args += piece;
          yield { type: "tool_args_delta", id: cur.id, json: piece };
        }
      }

      if (choice.finish_reason) {
        stop = {
          type: "stop",
          reason:
            choice.finish_reason === "tool_calls" || calls.size > 0
              ? "tool_use"
              : choice.finish_reason === "length"
                ? "max_tokens"
                : "end_turn",
        };
      }
    }

    for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      yield { type: "tool_end", id: c.id, input: parseArgs(c.args) };
    }
    yield stop ?? { type: "stop", reason: calls.size ? "tool_use" : "other" };
  },
};

function toChatMessages(req: ProviderRequest): unknown[] {
  const out: unknown[] = [];
  const sys = req.system.map((b) => b.text).filter(Boolean).join("\n\n");
  if (sys) out.push({ role: "system", content: sys });

  for (const m of req.messages) out.push(...convertMessage(m));
  return out;
}

function convertMessage(m: WireMessage): unknown[] {
  const text = m.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  if (m.role === "assistant") {
    const toolCalls = m.content
      .filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use")
      .map((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
    const msg: Record<string, unknown> = { role: "assistant", content: text || null };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    return [msg];
  }

  const results = m.content.filter(
    (b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result",
  );
  const out: unknown[] = [];
  if (text) out.push({ role: "user", content: text });
  for (const r of results) {
    out.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.content || "(no output)" });
  }
  if (!out.length) out.push({ role: "user", content: "(empty)" });
  return out;
}

function toUsage(u: any): Usage {
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
  };
}
