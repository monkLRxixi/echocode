import fs from "node:fs";
import path from "node:path";
import { normalizeNewlines } from "../platform.js";

export interface ToolContext {
  cwd: string;
}

export interface ToolResult {
  ok: boolean;
  text: string;
  meta?: string;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  isReadOnly?: boolean;
  mutating?: "edit" | "exec";
  run(input: Record<string, any>, ctx: ToolContext): Promise<ToolResult>;
}

export function resolvePath(ctx: ToolContext, p: unknown): string {
  const s = typeof p === "string" ? p.trim() : "";
  if (!s) throw new Error("file_path is required");
  return path.isAbsolute(s) ? s : path.resolve(ctx.cwd, s);
}

export function relPath(ctx: ToolContext, abs: string): string {
  const r = path.relative(ctx.cwd, abs);
  return r.startsWith("..") ? abs : r || ".";
}

export function readTextFile(abs: string): string {
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) throw new Error(`${abs} looks binary (contains NUL bytes)`);
  return normalizeNewlines(buf.toString("utf8"));
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
