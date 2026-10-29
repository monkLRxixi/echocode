import { spawn } from "node:child_process";
import type { Tool, ToolContext, ToolResult } from "./fsutil.js";

const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT = 120_000;
const HARD_TIMEOUT = 600_000;

export const Bash: Tool = {
  name: "Bash",
  description:
    "Execute a shell command and return its output. Prefer Read/Edit/Write for file work. " +
    "Long-running or interactive commands will time out — use flags that make them non-interactive " +
    "(e.g. -y, --no-pager, </dev/null).",
  mutating: "exec",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run." },
      timeout: { type: "number", description: "Timeout in milliseconds (max 600000)." },
      description: { type: "string", description: "5-10 word description of what this does." },
    },
    required: ["command"],
    additionalProperties: false,
  },

  async run(input: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
    const command = String(input.command ?? "").trim();
    if (!command) return { ok: false, text: "command is empty" };
    const timeout = Math.min(Number(input.timeout) || DEFAULT_TIMEOUT, HARD_TIMEOUT);
    const shell = process.env.SHELL || "/bin/bash";

    return await new Promise<ToolResult>((resolve) => {
      const started = Date.now();
      const child = spawn(shell, ["-lc", command], {
        cwd: ctx.cwd,
        env: { ...process.env, ECHOCODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let killedByTimeout = false;
      let settled = false;

      const timer = setTimeout(() => {
        killedByTimeout = true;
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeout);

      child.stdout?.on("data", (d: Buffer) => {
        if (stdout.length < MAX_OUTPUT * 2) stdout += d.toString();
      });
      child.stderr?.on("data", (d: Buffer) => {
        if (stderr.length < MAX_OUTPUT * 2) stderr += d.toString();
      });

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const ms = Date.now() - started;
        let body = "";
        if (stdout.trim()) body += stdout.trimEnd();
        if (stderr.trim()) body += (body ? "\n\n" : "") + "[stderr]\n" + stderr.trimEnd();
        if (body.length > MAX_OUTPUT) body = `${body.slice(0, MAX_OUTPUT)}\n… (output truncated)`;
        if (killedByTimeout) body = `(killed after ${timeout}ms timeout)\n${body}`;
        else if (code !== 0) body = `(exit ${code})\n${body}`;
        if (!body) body = `(no output, exit ${code})`;
        resolve({ ok: code === 0 && !killedByTimeout, text: body, meta: `${ms}ms` });
      };

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, text: `failed to start ${shell}: ${err.message}` });
      });
      child.on("close", finish);
    });
  },
};
