import { c, g } from "../theme.js";
import type { AgentCallbacks } from "../agent.js";
import type { Usage } from "../types.js";

export interface PlainOptions {
  out?: NodeJS.WriteStream;
  err?: NodeJS.WriteStream;
  verbose?: boolean;
}

/** Streaming renderer for `--print` (and for non-TTY sessions). */
export function createPlainRenderer(opts: PlainOptions = {}): AgentCallbacks & { done(): void } {
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  let lineBuf = "";

  return {
    onTextDelta(text) {
      let s = text;
      while (true) {
        const nl = s.indexOf("\n");
        if (nl < 0) {
          if (s) out.write(c.white(s));
          lineBuf += s;
          return;
        }
        out.write(c.white(s.slice(0, nl + 1)));
        lineBuf = "";
        s = s.slice(nl + 1);
      }
    },

    onToolStart() {
      /* the finished line carries the args, so nothing to print yet */
    },

    onToolFinish(info) {
      if (lineBuf) {
        out.write("\n");
        lineBuf = "";
      }
      const args = summarise(info.name, info.input);
      const head = info.ok ? c.green(g.ok) : c.red(g.ok);
      out.write(`${head} ${c.greenBold(info.name)}${args ? c.dim(`(${args})`) : ""}\n`);
      const lines = info.text.split("\n");
      const shown = lines.slice(0, 8);
      if (shown[0]) out.write(`${c.green(g.branch)}  ${c.dim(shown[0])}\n`);
      for (const l of shown.slice(1)) out.write(`   ${c.faint(l)}\n`);
      if (lines.length > shown.length) out.write(`   ${c.faint(`… +${lines.length - shown.length} more lines`)}\n`);
      if (info.meta) out.write(`   ${c.faint(info.meta)}\n`);
    },

    onUsage(u: Usage) {
      if (!opts.verbose) return;
      const parts = [];
      if (u.inputTokens) parts.push(`in ${u.inputTokens}`);
      if (u.outputTokens) parts.push(`out ${u.outputTokens}`);
      if (u.cacheRead) parts.push(`cache-hit ${u.cacheRead}`);
      if (u.cost) parts.push(`~$${u.cost.toFixed(4)}`);
      if (parts.length) err.write(c.faint(`  ${parts.join(" · ")}\n`));
    },

    onNotice(text) {
      if (lineBuf) {
        out.write("\n");
        lineBuf = "";
      }
      err.write(`${c.yellow("!")} ${c.dim(text)}\n`);
    },

    done() {
      if (lineBuf) out.write("\n");
      lineBuf = "";
    },
  };
}

export function summarise(name: string, input: Record<string, unknown> = {}): string {
  const pick = (k: string) => (input[k] === undefined ? null : String(input[k]));
  switch (name) {
    case "Bash":
      return truncate(pick("command") ?? "", 72);
    case "Read":
    case "Write":
    case "Edit":
      return truncate(pick("file_path") ?? "", 72);
    default: {
      const keys = Object.keys(input);
      if (!keys.length) return "";
      return truncate(
        keys
          .slice(0, 3)
          .map((k) => `${k}=${truncate(JSON.stringify(input[k]), 24)}`)
          .join(" "),
        72,
      );
    }
  }
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}
