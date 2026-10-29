import fs from "node:fs";
import path from "node:path";
import { HOME_DIR, projectSlug } from "./config.js";
import type { Block, Usage, WireMessage } from "./types.js";

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cost: number;
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly model: string;
  readonly messages: WireMessage[] = [];
  readonly usage: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cost: 0 };
  readonly startedAt = new Date().toISOString();
  readonly dir: string;
  readonly file: string;

  constructor(opts: { cwd: string; model: string; id?: string }) {
    this.id = opts.id ?? crypto.randomUUID();
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.dir = path.join(HOME_DIR, "projects", projectSlug(opts.cwd));
    this.file = path.join(this.dir, `${this.id}.jsonl`);
  }

  private append(entry: Record<string, unknown>): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    } catch {
      /* persistence is best effort */
    }
  }

  pushUser(text: string): void {
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    this.append({ type: "user", text });
  }

  pushAssistant(content: Block[]): void {
    this.messages.push({ role: "assistant", content });
    this.append({ type: "assistant", content });
  }

  pushToolResults(content: Block[]): void {
    this.messages.push({ role: "user", content });
    this.append({ type: "tool_result", content });
  }

  addUsage(u: Usage): void {
    this.usage.inputTokens += u.inputTokens ?? 0;
    this.usage.outputTokens += u.outputTokens ?? 0;
    this.usage.cacheRead += u.cacheRead ?? 0;
    this.usage.cost += u.cost ?? 0;
  }

  clear(): void {
    this.messages.length = 0;
    this.append({ type: "clear" });
  }
}
