import type { Provider, ProviderRequest, StreamEvent, SystemBlock, Usage, WireMessage } from "../types.js";
import { parseJson, sseFrames } from "./sse.js";
import { postJson } from "./http.js";

export const BETAS = [
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
];

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export const anthropic: Provider = {
  id: "anthropic-message",
  label: "anthropic-message",
  defaultBaseUrl: "https://api.anthropic.com",
  defaultModel: "claude-sonnet-4-5",
  keyEnv: ["ECHOCODE_API_KEY", "ANTHROPIC_API_KEY"],

  async *stream(req: ProviderRequest, o): AsyncGenerator<StreamEvent> {
    const res = await postJson(
      "/v1/messages",
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: toSystem(req.system),
        messages: req.messages.map(toAnthropicMessage),
        tools: req.tools,
        stream: true,
      },
      {
        baseUrl: o.baseUrl,
        apiKey: null,
        authToken: null,
        signal: o.signal,
        headers: {
          ...(o.headers ?? {}),
          "x-api-key": o.apiKey ?? "",
          ...(o.authToken ? { authorization: `Bearer ${o.authToken}` } : {}),
          "anthropic-version": "2023-06-01",
          "anthropic-beta": BETAS.join(","),
        },
        wantStream: true,
      },
    );

    const args = new Map<number, string>();
    const ids = new Map<number, string>();
    let stopped = false;

    for await (const frame of sseFrames(res)) {
      const ev = parseJson<Record<string, any>>(frame.data);
      if (!ev) continue;
      switch (ev.type) {
        case "message_start": {
          const u: AnthropicUsage = ev.message?.usage ?? {};
          yield { type: "usage", usage: toUsage(u) };
          break;
        }
        case "content_block_start": {
          const cb = ev.content_block ?? {};
          if (cb.type === "tool_use") {
            args.set(ev.index, "");
            ids.set(ev.index, cb.id);
            yield { type: "tool_start", id: cb.id, name: cb.name };
          } else if (cb.type === "text" && cb.text) {
            yield { type: "text_delta", text: String(cb.text) };
          }
          break;
        }
        case "content_block_delta": {
          const d = ev.delta ?? {};
          if (d.type === "text_delta" && d.text) {
            yield { type: "text_delta", text: String(d.text) };
          } else if (d.type === "input_json_delta") {
            const prev = args.get(ev.index) ?? "";
            args.set(ev.index, prev + String(d.partial_json ?? ""));
            yield {
              type: "tool_args_delta",
              id: ids.get(ev.index) ?? String(ev.index),
              json: String(d.partial_json ?? ""),
            };
          }
          break;
        }
        case "content_block_stop": {
          const json = args.get(ev.index);
          if (json !== undefined) {
            args.delete(ev.index);
            const id = ids.get(ev.index) ?? String(ev.index);
            ids.delete(ev.index);
            yield { type: "tool_end", id, input: parseArgs(json) };
          }
          break;
        }
        case "message_delta": {
          const u = (ev.usage ?? {}) as AnthropicUsage;
          if (u.output_tokens !== undefined) {
            yield { type: "usage", usage: { outputTokens: u.output_tokens } };
          }
          if (ev.delta?.stop_reason) {
            stopped = true;
            yield { type: "stop", reason: mapStop(ev.delta.stop_reason, args.size > 0) };
          }
          break;
        }
        case "error": {
          throw new Error(`anthropic: ${JSON.stringify(ev.error ?? ev)}`);
        }
        default:
          break;
      }
    }

    if (!stopped) yield { type: "stop", reason: "other" };
  },
};

function toSystem(system: SystemBlock[]) {
  if (!system.length) return undefined;
  return system.map((b) => ({
    type: "text" as const,
    text: b.text,
    ...(b.cache_control ? { cache_control: b.cache_control } : {}),
  }));
}

function toAnthropicMessage(m: WireMessage) {
  return { role: m.role, content: m.content };
}

function toUsage(u: AnthropicUsage): Usage {
  return {
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
  };
}

export function parseArgs(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapStop(reason: string, hasTools: boolean) {
  if (reason === "tool_use" || hasTools) return "tool_use" as const;
  if (reason === "max_tokens") return "max_tokens" as const;
  if (reason === "end_turn" || reason === "stop_sequence") return "end_turn" as const;
  return "other" as const;
}
