import type { Provider, ProviderRequest, StreamEvent, Usage, WireMessage } from "../types.js";
import { parseJson, sseFrames } from "./sse.js";
import { postJson } from "./http.js";
import { parseArgs } from "./anthropic.js";

/**
 * OpenAI Responses API (`POST /responses`, item-based input, `response.*` events).
 * Stateless usage: `store: false` and the full input replayed every turn.
 */
export const openaiResponses: Provider = {
  id: "openai-response",
  label: "openai-response",
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-5",
  keyEnv: ["ECHOCODE_API_KEY", "OPENAI_API_KEY"],

  async *stream(req: ProviderRequest, o): AsyncGenerator<StreamEvent> {
    const res = await postJson(
      "/responses",
      {
        model: req.model,
        stream: true,
        store: false,
        max_output_tokens: req.maxTokens,
        instructions: req.system.map((b) => b.text).filter(Boolean).join("\n\n") || undefined,
        input: toInput(req.messages),
        ...(req.tools.length
          ? {
              tools: req.tools.map((t) => ({
                type: "function",
                name: t.name,
                description: t.description,
                parameters: t.input_schema,
              })),
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

    // item_id -> { callId, name, args }
    const calls = new Map<string, { callId: string; name: string; args: string }>();
    const byCallId = new Map<string, string>(); // callId -> item_id
    let stop: StreamEvent | null = null;

    for await (const frame of sseFrames(res)) {
      const ev = parseJson<any>(frame.data);
      if (!ev) continue;
      const type: string = ev.type ?? frame.event ?? "";

      switch (type) {
        case "response.output_text.delta":
          if (ev.delta) yield { type: "text_delta", text: String(ev.delta) };
          break;

        case "response.output_item.added": {
          const item = ev.item ?? {};
          if (item.type === "function_call") {
            const itemId = String(item.id ?? item.call_id ?? "");
            const callId = String(item.call_id ?? item.id ?? "");
            calls.set(itemId, { callId, name: String(item.name ?? ""), args: String(item.arguments ?? "") });
            byCallId.set(callId, itemId);
            yield { type: "tool_start", id: callId, name: String(item.name ?? "") };
          }
          break;
        }

        case "response.function_call_arguments.delta": {
          const itemId = String(ev.item_id ?? "");
          const c = calls.get(itemId);
          if (c && ev.delta) {
            c.args += String(ev.delta);
            yield { type: "tool_args_delta", id: c.callId, json: String(ev.delta) };
          }
          break;
        }

        case "response.output_item.done": {
          const item = ev.item ?? {};
          if (item.type === "function_call") {
            const itemId = String(item.id ?? "");
            const c = calls.get(itemId);
            const callId = String(item.call_id ?? c?.callId ?? "");
            const args = String(item.arguments ?? c?.args ?? "");
            calls.delete(itemId);
            yield {
              type: "tool_end",
              id: callId,
              input: parseArgs(args),
            };
          }
          break;
        }

        case "response.completed": {
          const u = ev.response?.usage ?? {};
          yield { type: "usage", usage: toUsage(u) };
          const hasCalls = (ev.response?.output ?? []).some((x: any) => x?.type === "function_call");
          stop = { type: "stop", reason: hasCalls ? "tool_use" : "end_turn" };
          break;
        }

        case "response.incomplete": {
          stop = { type: "stop", reason: "max_tokens" };
          break;
        }

        case "response.failed":
        case "error": {
          const msg = ev.response?.error?.message ?? ev.error?.message ?? ev.message ?? "request failed";
          throw new Error(`openai-responses: ${msg}`);
        }

        default:
          break;
      }
    }

    // Any tool that never got its output_item.done still has to be callable.
    for (const [, c] of calls) {
      yield { type: "tool_end", id: c.callId, input: parseArgs(c.args) };
    }
    yield stop ?? { type: "stop", reason: calls.size ? "tool_use" : "other" };
  },
};

function toInput(messages: WireMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    const text = m.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (m.role === "assistant") {
      if (text) out.push({ role: "assistant", content: [{ type: "output_text", text }] });
      for (const b of m.content) {
        if (b.type === "tool_use") {
          out.push({
            type: "function_call",
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          });
        }
      }
      continue;
    }

    if (text) out.push({ role: "user", content: [{ type: "input_text", text }] });
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push({ type: "function_call_output", call_id: b.tool_use_id, output: b.content || "(no output)" });
      }
    }
  }
  return out;
}

function toUsage(u: any): Usage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheRead: u.input_tokens_details?.cached_tokens ?? 0,
  };
}
