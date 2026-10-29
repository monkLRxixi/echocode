import { spawn, type SpawnOptions } from "node:child_process";
import type { Tool, ToolContext, ToolResult } from "./fsutil.js";
import { isWindows, normalizeNewlines } from "../platform.js";

const MAX_OUTPUT = 30_000;
const DEFAULT_TIMEOUT = 120_000;
const HARD_TIMEOUT = 600_000;

/** cmd.exe on Windows, the user's shell elsewhere. */
export function shellCommand(command: string): { file: string; args: string[] } {
  if (isWindows) {
    const comspec = process.env.ComSpec || "cmd.exe";
    return { file: comspec, args: ["/d", "/s", "/c", command] };
  }
  return { file: process.env.SHELL || "/bin/bash", args: ["-lc", command] };
}

export const Bash: Tool = {
  name: "Bash",
  description:
    "Execute a shell command and return its output. Prefer Read/Edit/Write for file work. " +
    "Runs through the user's shell ($SHELL on POSIX, cmd.exe on Windows). " +
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
    const { file, args } = shellCommand(command);

    return await new Promise<ToolResult>((resolve) => {
      const started = Date.now();
      const options: SpawnOptions = {
        cwd: ctx.cwd,
        env: { ...process.env, ECHOCODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        // POSIX: own process group so a timeout can kill the whole tree.
        // Windows: taskkill /T does that for us.
        detached: !isWindows,
        windowsHide: true,
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(file, args, options);
      } catch (err: any) {
        resolve({ ok: false, text: `failed to start ${file}: ${err?.message ?? String(err)}` });
        return;
      }

      let stdout = "";
      let stderr = "";
      let killedByTimeout = false;
      let settled = false;

      const killTree = () => {
        if (!child.pid) {
          child.kill();
          return;
        }
        if (isWindows) {
          spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            stdio: "ignore",
            windowsHide: true,
          }).on("error", () => child.kill());
          return;
        }
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };

      const timer = setTimeout(() => {
        killedByTimeout = true;
        killTree();
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
        body = normalizeNewlines(body);
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
        resolve({ ok: false, text: `failed to start ${file}: ${err.message}` });
      });
      child.on("close", finish);
    });
  },
};
