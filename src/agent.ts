import fs from "node:fs";
import { env } from "./env.js";
import type { Config } from "./config.js";
import type { Block, ProviderRequest, SystemBlock, ToolResultBlock, ToolSpec, ToolUseBlock, Usage } from "./types.js";
import type { Tool } from "./tools/fsutil.js";
import type { Permissions } from "./permissions.js";
import type { Session } from "./session.js";
import { ApiError } from "./providers/http.js";

export interface AgentDeps {
  cfg: Config;
  session: Session;
  permissions: Permissions;
  system: () => SystemBlock[];
  /** tools that are enabled AND allowed in this mode (execution whitelist) */
  tools: Tool[];
  /** wire schemas for the same list */
  specs: ToolSpec[];
  /** soft context budget, in estimated tokens */
  contextLimit?: number;
}

export interface ToolStarted {
  id: string;
  name: string;
}

export interface ToolFinished {
  id: string;
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  text: string;
  meta?: string;
}

export interface AgentCallbacks {
  onTextDelta(text: string): void;
  onToolStart(info: ToolStarted): void;
  onToolFinish(info: ToolFinished): void;
  onUsage(delta: Usage): void;
  onNotice?(text: string): void;
}

export interface RunResult {
  interrupted?: boolean;
  hitTurnLimit?: boolean;
  error?: string;
}

const TOOL_RESULT_LIMIT = 30_000;

interface ConsumeResult {
  blocks: Block[];
  usage: Usage;
  stop: string;
  results: ToolResultBlock[];
}

export class Agent {
  private abort: AbortController | null = null;

  constructor(private deps: AgentDeps) {}

  interrupt(): void {
    this.abort?.abort();
  }

  async run(userText: string, cb: AgentCallbacks): Promise<RunResult> {
    const { session, cfg, permissions } = this.deps;
    session.pushUser(userText);

    for (let turn = 1; turn <= cfg.maxTurns; turn++) {
      this.enforceContextBudget(cb);

      const request: ProviderRequest = {
        model: cfg.model,
        maxTokens: cfg.maxTokens,
        system: this.deps.system(),
        messages: session.messages,
        tools: this.deps.specs,
      };

      const debugFile = env("DEBUG_REQUEST");
      if (debugFile) {
        try {
          fs.writeFileSync(debugFile, JSON.stringify(request, null, 1));
        } catch {
          /* debugging aid only */
        }
      }

      this.abort = new AbortController();
      let out: ConsumeResult;
      try {
        out = await this.consume(request, cb);
      } catch (err: any) {
        if (err?.name === "AbortError") {
          cb.onNotice?.("interrupted");
          return { interrupted: true };
        }
        const message = err instanceof ApiError ? err.message : (err?.message ?? String(err));
        cb.onNotice?.(`error: ${message}`);
        if (err instanceof ApiError && err.status === 401) {
          cb.onNotice?.(
            `check the API key for ${cfg.providerName} (${cfg.provider.keyEnv.join(" / ")}) — ${cfg.paths.settings}`,
          );
        }
        return { error: message };
      } finally {
        this.abort = null;
      }

      const delta: Usage = { ...out.usage, cost: estimateCost(cfg.model, out.usage) };
      session.addUsage(delta);
      cb.onUsage(delta);
      session.pushAssistant(out.blocks);

      if (!out.results.length) return {};
      if (out.stop !== "tool_use" && out.stop !== "other") {
        // Provider said end_turn but tools ran anyway: still feed the results back.
      }
      session.pushToolResults(out.results);
    }

    cb.onNotice?.(`stopped after ${cfg.maxTurns} turns`);
    return { hitTurnLimit: true };
  }

  private async consume(request: ProviderRequest, cb: AgentCallbacks): Promise<ConsumeResult> {
    const { cfg, permissions } = this.deps;
    const blocks: Block[] = [];
    const results: ToolResultBlock[] = [];
    const usage: Usage = {};
    const index = new Map<string, number>();
    const rawArgs = new Map<string, string>();
    let textBlock: Extract<Block, { type: "text" }> | null = null;
    let stop = "end_turn";

    const runTool = async (block: ToolUseBlock): Promise<void> => {
      const tool = this.deps.tools.find((t) => t.name === block.name) ?? null;
      if (!tool) {
        const text = `unknown or disabled tool: ${block.name} (see tools.json)`;
        cb.onToolFinish({ id: block.id, name: block.name, input: block.input, ok: false, text });
        results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: text });
        return;
      }

      const started = Date.now();
      const verdict = await permissions.check(tool, block.input);
      if (!verdict.allow) {
        const reason = verdict.reason ?? "not allowed";
        cb.onToolFinish({
          id: block.id,
          name: block.name,
          input: block.input,
          ok: false,
          text: `denied — ${reason}`,
        });
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: `permission denied: ${reason}`,
        });
        return;
      }

      let ok: boolean;
      let text: string;
      let meta: string | undefined;
      try {
        const res = await tool.run(block.input, { cwd: cfg.cwd });
        ok = res.ok;
        text = res.text;
        meta = res.meta ?? `${Date.now() - started}ms`;
      } catch (err: any) {
        ok = false;
        text = err?.message ?? String(err);
        meta = `${Date.now() - started}ms`;
      }
      if (text.length > TOOL_RESULT_LIMIT) text = `${text.slice(0, TOOL_RESULT_LIMIT)}\n… (truncated)`;

      cb.onToolFinish({ id: block.id, name: block.name, input: block.input, ok, text, meta });
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        is_error: !ok,
        content: text || "(no output)",
      });
    };

    const stream = cfg.provider.stream(request, {
      signal: this.abort?.signal,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      authToken: cfg.authToken,
      headers: cfg.headers,
    });

    for await (const ev of stream) {
      switch (ev.type) {
        case "text_delta": {
          if (!textBlock) {
            textBlock = { type: "text", text: "" };
            blocks.push(textBlock);
          }
          textBlock.text += ev.text;
          cb.onTextDelta(ev.text);
          break;
        }
        case "tool_start": {
          textBlock = null;
          const block: ToolUseBlock = { type: "tool_use", id: ev.id, name: ev.name, input: {} };
          index.set(ev.id, blocks.length);
          rawArgs.set(ev.id, "");
          blocks.push(block);
          cb.onToolStart({ id: ev.id, name: ev.name });
          break;
        }
        case "tool_args_delta": {
          rawArgs.set(ev.id, (rawArgs.get(ev.id) ?? "") + ev.json);
          break;
        }
        case "tool_end": {
          textBlock = null;
          const i = index.get(ev.id);
          if (i === undefined) break;
          const block = blocks[i] as ToolUseBlock;
          block.input = ev.input;
          await runTool(block);
          break;
        }
        case "usage": {
          if (ev.usage.inputTokens !== undefined) usage.inputTokens = ev.usage.inputTokens;
          if (ev.usage.outputTokens !== undefined) usage.outputTokens = ev.usage.outputTokens;
          if (ev.usage.cacheRead !== undefined) usage.cacheRead = ev.usage.cacheRead;
          break;
        }
        case "stop":
          stop = ev.reason;
          break;
        default:
          break;
      }
    }

    return { blocks, usage, stop, results };
  }

  /** Manual compaction (the /compact command): drop old tool results to 50% of budget. */
  compact(): number {
    const limit = this.deps.contextLimit ?? 180_000;
    return this.trimContext(limit * 0.5);
  }

  private enforceContextBudget(cb: AgentCallbacks): void {
    const limit = this.deps.contextLimit ?? 180_000;
    const size = estimateTokens(this.deps.session.messages);
    if (size <= limit) return;
    const dropped = this.trimContext(limit * 0.7);
    if (dropped) cb.onNotice?.(`context budget: dropped ${dropped} old tool result(s)`);
  }

  private trimContext(target: number): number {
    let size = estimateTokens(this.deps.session.messages);
    let dropped = 0;
    for (const m of this.deps.session.messages) {
      if (size <= target) break;
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (block.type !== "tool_result") continue;
        const before = block.content.length;
        block.content = "(old tool result dropped to save context)";
        size -= Math.max(0, before / 4 - 10);
        dropped++;
      }
    }
    return dropped;
  }
}

function estimateTokens(messages: { role: string; content: Block[] }[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

const PRICES: Record<string, { in: number; out: number }> = {
  haiku: { in: 0.8, out: 4 },
  sonnet: { in: 3, out: 15 },
  opus: { in: 15, out: 75 },
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-5": { in: 1.25, out: 10 },
  o4: { in: 1, out: 4 },
};

export function estimateCost(model: string, usage: Usage): number {
  const key = Object.keys(PRICES).find((k) => model.toLowerCase().includes(k)) ?? "sonnet";
  const p = PRICES[key]!;
  return ((usage.inputTokens ?? 0) * p.in + (usage.outputTokens ?? 0) * p.out) / 1e6;
}
