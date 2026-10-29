import type { Tool } from "./tools/fsutil.js";
import type { PermissionMode } from "./config-types.js";
import type { PermissionRules } from "./tools-config.js";

export type PermissionAnswer = "yes" | "always" | "no";

export interface Verdict {
  allow: boolean;
  reason?: string;
  /** which settings rule decided it, when one did */
  rule?: string;
}

/**
 * The TUI installs a real handler here; print mode leaves it empty, so anything
 * that is not pre-approved is denied with an explanation.
 */
export const permissionBridge: {
  ask?: (tool: Tool, input: Record<string, unknown>) => Promise<PermissionAnswer>;
} = {};

const READ_ONLY = new Set(["Read"]);

/** `Read` | `Bash(npm test:*)` | `Edit(src/**)` — `*` is a wildcard. */
export function parseRule(rule: string): { tool: string; arg?: string } | null {
  const m = /^([A-Za-z_][\w.-]*)\s*(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return null;
  return { tool: m[1]!, arg: m[2] };
}

function primaryArg(tool: Tool, input: Record<string, unknown>): string {
  const raw =
    tool.name === "Bash" ? input.command : (input.file_path ?? input.notebook_path ?? input.pattern ?? "");
  return String(raw ?? "");
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function ruleMatches(rule: string, toolName: string, input: Record<string, unknown>, tool: Tool): boolean {
  const parsed = parseRule(rule);
  if (!parsed) return false;
  if (parsed.tool !== "*" && parsed.tool !== toolName) return false;
  if (parsed.arg === undefined) return true;

  const value = primaryArg(tool, input);
  const pattern = parsed.arg.trim();
  if (!pattern) return true;

  // "Bash(npm test:*)" is the common prefix form; a bare literal also matches
  // as a prefix so "Edit(src/a.ts)" works for absolute cwd-relative paths.
  const needle = pattern.endsWith(":*") ? pattern.slice(0, -2) : pattern;
  if (pattern.includes("*") || pattern.includes("?")) {
    if (globToRegExp(pattern).test(value)) return true;
    if (pattern.endsWith(":*") && globToRegExp(`${needle}*`).test(value)) return true;
  }
  return value === needle || value.startsWith(needle);
}

export class Permissions {
  mode: PermissionMode;
  isTTY: boolean;
  rules: PermissionRules;
  rulesSource: string;
  readonly sessionAllow = new Set<string>();
  denials = 0;

  constructor(opts: { mode: PermissionMode; isTTY: boolean; rules?: PermissionRules; rulesSource?: string }) {
    this.mode = opts.mode;
    this.isTTY = opts.isTTY;
    this.rules = opts.rules ?? {};
    this.rulesSource = opts.rulesSource ?? "tools.json";
  }

  get planMode(): boolean {
    return this.mode === "plan";
  }

  /** Plan mode narrows the tool list itself: cheaper than failing every call. */
  allowedTools<T extends { name: string }>(tools: T[]): T[] {
    return this.planMode ? tools.filter((t) => READ_ONLY.has(t.name)) : tools;
  }

  /** settings.json `permissions.deny` / `permissions.allow` */
  private matchRules(tool: Tool, input: Record<string, unknown>): Verdict | null {
    for (const rule of this.rules.deny ?? []) {
      if (ruleMatches(rule, tool.name, input, tool)) {
        return { allow: false, reason: `${this.rulesSource} denies ${rule} (permissions.deny)`, rule };
      }
    }
    for (const rule of this.rules.allow ?? []) {
      if (ruleMatches(rule, tool.name, input, tool)) return { allow: true, rule };
    }
    return null;
  }

  async check(tool: Tool, input: Record<string, unknown>): Promise<Verdict> {
    const byRule = this.matchRules(tool, input);
    if (byRule) return byRule;

    if (this.mode === "bypassPermissions") return { allow: true };
    if (READ_ONLY.has(tool.name)) return { allow: true };
    if (this.planMode) {
      return {
        allow: false,
        reason:
          "plan mode is on: I can read and explore but not modify anything. Present the plan, then the user can re-run with edits enabled.",
      };
    }
    if (this.sessionAllow.has(tool.name)) return { allow: true };
    if (this.mode === "acceptEdits" && tool.mutating === "edit") return { allow: true };
    if (this.mode === "auto" && tool.mutating === "edit") return { allow: true };

    if (!this.isTTY || !permissionBridge.ask) {
      this.denials++;
      return {
        allow: false,
        reason: `permission required to run ${tool.name} but this session is non-interactive; re-run with --yes or allow it in settings.json`,
      };
    }

    const answer = await permissionBridge.ask(tool, input);
    if (answer === "always") {
      this.sessionAllow.add(tool.name);
      return { allow: true };
    }
    if (answer === "yes") return { allow: true };
    this.denials++;
    return { allow: false, reason: "the user declined this tool call; do not retry it verbatim" };
  }
}
