import fs from "node:fs";
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { glyph, p, SPINNER } from "./theme.js";
import type { Agent, AgentCallbacks } from "../agent.js";
import type { Config } from "../config.js";
import { permissionBridge, type PermissionAnswer, type Permissions } from "../permissions.js";
import type { Session } from "../session.js";
import type { Usage } from "../types.js";
import type { Tool } from "../tools/fsutil.js";
import { ALL_TOOLS } from "../tools/index.js";
import { VERSION } from "../prompt.js";
import { COMMANDS, completionFor, displayText, findCommand, suggestCommands, type SlashCommand } from "./commands.js";
import { itemLines, transcriptLines, type Item, type Line, type Span } from "./lines.js";
import { env } from "../env.js";

/* ------------------------------- state ------------------------------ */

type ActiveTool = { id: string; name: string };

interface State {
  items: Item[];
  live: string;
  tools: ActiveTool[];
  usage: Usage;
  running: boolean;
  notice: string | null;
  seq: number;
}

type Action =
  | { type: "user"; text: string }
  | { type: "text"; text: string }
  | { type: "toolStart"; id: string; name: string }
  | { type: "toolFinish"; id: string; name: string; input: Record<string, unknown>; ok: boolean; text: string; meta?: string }
  | { type: "notice"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "running"; on: boolean }
  | { type: "commit" }
  | { type: "clear" };

const initial: State = { items: [], live: "", tools: [], usage: {}, running: false, notice: null, seq: 0 };

function initState(cwd: string, label?: string | null): State {
  return {
    ...initial,
    seq: 1,
    items: [{ key: "banner", kind: "banner", cwd, label: label ?? null }],
  };
}

function reducer(state: State, a: Action): State {
  switch (a.type) {
    case "user":
      return { ...state, seq: state.seq + 1, items: [...state.items, { key: `i${state.seq}`, kind: "user", text: a.text }] };

    case "text":
      return { ...state, live: state.live + a.text };

    case "commit":
      if (!state.live) return state;
      return {
        ...state,
        seq: state.seq + 1,
        live: "",
        items: [...state.items, { key: `i${state.seq}`, kind: "assistant", text: state.live }],
      };

    case "toolStart": {
      const items = state.live
        ? [...state.items, { key: `i${state.seq}`, kind: "assistant" as const, text: state.live }]
        : state.items;
      return {
        ...state,
        seq: state.live ? state.seq + 1 : state.seq,
        live: "",
        items,
        tools: [...state.tools, { id: a.id, name: a.name }],
      };
    }

    case "toolFinish": {
      const rest = state.tools.filter((t) => t.id !== a.id);
      const items = state.live
        ? [...state.items, { key: `i${state.seq}`, kind: "assistant" as const, text: state.live }]
        : state.items;
      return {
        ...state,
        seq: (state.live ? state.seq + 1 : state.seq) + 1,
        live: "",
        tools: rest,
        items: [
          ...items,
          { key: `t${state.seq}`, kind: "tool", name: a.name, input: a.input, ok: a.ok, text: a.text, meta: a.meta },
        ],
      };
    }

    case "notice":
      return { ...state, notice: a.text };

    case "usage":
      return {
        ...state,
        usage: {
          inputTokens: (state.usage.inputTokens ?? 0) + (a.usage.inputTokens ?? 0),
          outputTokens: (state.usage.outputTokens ?? 0) + (a.usage.outputTokens ?? 0),
          cacheRead: (state.usage.cacheRead ?? 0) + (a.usage.cacheRead ?? 0),
          cost: (state.usage.cost ?? 0) + (a.usage.cost ?? 0),
        },
      };

    case "running":
      return { ...state, running: a.on, ...(a.on ? { notice: null } : {}) };

    case "clear":
      return { ...initial, usage: state.usage };

    default:
      return state;
  }
}

/* ------------------------------ component --------------------------- */

export interface AppProps {
  cfg: Config;
  agent: Agent;
  session: Session;
  permissions: Permissions;
  mockLabel?: string | null;
  onExit: () => void | Promise<void>;
}

const FOOTER_ROWS = 2;
const COMPOSER_ROWS = 3; // top border / input / bottom border
const PERM_ROWS = 5; // rounded box: border + 3 lines + border

export function App({ cfg, agent, session, permissions, mockLabel, onExit }: AppProps) {
  const [state, dispatch] = useReducer(reducer, initState(cfg.cwd, mockLabel), (s) => s);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [perm, setPerm] = useState<{ tool: Tool; input: Record<string, unknown> } | null>(null);
  const [frame, setFrame] = useState(0);
  const [menuSel, setMenuSel] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [scroll, setScroll] = useState(0);
  const { exit } = useApp();
  const { stdout: out } = useStdout();

  const [size, setSize] = useState({ rows: out?.rows ?? 24, cols: out?.columns ?? 80 });
  useEffect(() => {
    if (!out) return;
    const onResize = () => setSize({ rows: out.rows ?? 24, cols: out.columns ?? 80 });
    out.on("resize", onResize);
    return () => {
      out.off("resize", onResize);
    };
  }, [out]);

  const permResolve = useRef<((a: PermissionAnswer) => void) | null>(null);
  const inputRef = useRef("");
  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    if (!state.running) return;
    const t = setInterval(() => setFrame((f) => f + 1), 90);
    return () => clearInterval(t);
  }, [state.running]);

  useEffect(() => {
    permissionBridge.ask = (tool, toolInput) =>
      new Promise<PermissionAnswer>((resolve) => {
        permResolve.current = resolve;
        setPerm({ tool, input: toolInput });
      });
    return () => {
      delete permissionBridge.ask;
    };
  }, []);

  const cols = Math.max(24, size.cols);
  const rows = Math.max(10, size.rows);

  const busyLabel = state.tools.length ? state.tools[0]!.name : "working";
  const menu = perm || state.running || menuDismissed ? [] : suggestCommands(input);
  const sel = menu.length ? Math.min(menuSel, menu.length - 1) : 0;

  const spinner = SPINNER[frame % SPINNER.length] ?? SPINNER[0];

  /* ---- rows budget: transcript viewport is whatever is left ---- */
  const menuRows = menu.length ? Math.min(menu.length, 8) + (menu.length > 8 ? 1 : 0) : 0;
  const permRows = perm ? PERM_ROWS : 0;
  const bottomRows = menuRows + permRows + COMPOSER_ROWS + FOOTER_ROWS;
  const viewport = Math.max(3, rows - bottomRows);

  const allLines = useMemo<Line[]>(() => {
    const lines = transcriptLines(state.items, cols);
    if (state.live) {
      lines.push([]);
      lines.push(...itemLines({ key: "live", kind: "assistant", text: state.live }, cols));
    }
    return lines;
  }, [state.items, state.live, state.tools, cols, spinner]);

  // follow the tail unless the user scrolled up
  const maxScroll = Math.max(0, allLines.length - viewport);
  const scrollNow = Math.min(scroll, maxScroll);
  const end = allLines.length - scrollNow;
  const start = Math.max(0, end - viewport);
  const visible = allLines.slice(start, end);

  const viewportRef = useRef(viewport);
  const maxScrollRef = useRef(maxScroll);
  viewportRef.current = viewport;
  maxScrollRef.current = maxScroll;

  const wheel = useCallback(
    (dir: -1 | 1) => {
      if (menu.length) {
        setMenuSel((i) => (i + dir + menu.length) % menu.length);
        return;
      }
      const step = 3;
      if (dir < 0) setScroll((s) => Math.min(maxScrollRef.current, s + step));
      else setScroll((s) => Math.max(0, s - step));
    },
    [menu.length],
  );

  useEffect(() => {
    setScroll(0);
  }, [allLines.length]);

  /* ------------------------------ actions ---------------------------- */

  const callbacks = useMemo<AgentCallbacks>(
    () => ({
      onTextDelta: (text) => dispatch({ type: "text", text }),
      onToolStart: (info) => dispatch({ type: "toolStart", id: info.id, name: info.name }),
      onToolFinish: (info) =>
        dispatch({
          type: "toolFinish",
          id: info.id,
          name: info.name,
          input: info.input,
          ok: info.ok,
          text: info.text,
          meta: info.meta,
        }),
      onUsage: (usage) => dispatch({ type: "usage", usage }),
      onNotice: (text) => dispatch({ type: "notice", text }),
    }),
    [],
  );

  const quit = useCallback(async () => {
    await onExit();
    exit();
  }, [exit, onExit]);

  const answerPerm = useCallback((a: PermissionAnswer) => {
    const r = permResolve.current;
    permResolve.current = null;
    setPerm(null);
    r?.(a);
  }, []);

  const runPrompt = useCallback(
    async (text: string) => {
      dispatch({ type: "running", on: true });
      try {
        await agent.run(text, callbacks);
      } finally {
        dispatch({ type: "commit" });
        dispatch({ type: "running", on: false });
      }
    },
    [agent, callbacks],
  );

  const slash = useCallback(
    async (line: string) => {
      const cmd = findCommand(line);
      const arg = line.trim().replace(/^\/\S*/, "").trim();
      if (!cmd) {
        dispatch({ type: "notice", text: `unknown command ${line.split(/\s+/)[0]} — type /help` });
        return;
      }
      switch (cmd.name) {
        case "exit":
          return quit();
        case "help": {
          const rows_ = COMMANDS.filter((c) => !c.hidden);
          const pad = Math.max(...rows_.map((c) => displayText(c).length)) + 2;
          dispatch({
            type: "notice",
            text: rows_.map((c) => `${displayText(c).padEnd(pad)}${c.description}`).join("\n  "),
          });
          return;
        }
        case "clear":
          session.clear();
          dispatch({ type: "clear" });
          dispatch({ type: "notice", text: "context cleared; transcript kept on disk" });
          return;
        case "compact": {
          const dropped = agent.compact();
          dispatch({
            type: "notice",
            text: dropped ? `compacted: dropped ${dropped} old tool result(s)` : "nothing to compact yet",
          });
          return;
        }
        case "model":
          if (arg) {
            cfg.model = arg;
            dispatch({ type: "notice", text: `model → ${arg}` });
          } else dispatch({ type: "notice", text: `model: ${cfg.model}` });
          return;
        case "permissions":
          if (arg && ["default", "acceptEdits", "auto", "plan", "bypassPermissions"].includes(arg)) {
            permissions.mode = arg as typeof permissions.mode;
            dispatch({ type: "notice", text: `permission mode → ${arg}` });
          } else dispatch({ type: "notice", text: `permission mode: ${permissions.mode}` });
          return;
        case "cost":
          dispatch({
            type: "notice",
            text:
              `tokens in ${session.usage.inputTokens} · out ${session.usage.outputTokens} · ` +
              `cache-hit ${session.usage.cacheRead} · ~$${session.usage.cost.toFixed(4)}`,
          });
          return;
        case "context":
          dispatch({
            type: "notice",
            text: `messages: ${session.messages.length} · est. tokens ~${Math.ceil(
              JSON.stringify(session.messages).length / 4,
            )} · budget ${cfg.contextLimit}`,
          });
          return;
        case "session":
          dispatch({ type: "notice", text: `session ${session.id} → ${session.file}` });
          return;
        case "tools": {
          const enabled = ALL_TOOLS.filter((t) => {
            const entry = cfg.toolsConfig[t.name];
            return typeof entry === "boolean" ? entry : (entry?.enabled ?? true);
          }).map((t) => t.name);
          dispatch({ type: "notice", text: `tools: ${enabled.join(", ") || "(none)"}  ·  ${cfg.paths.tools}` });
          return;
        }
        default:
          dispatch({ type: "notice", text: `/${cmd.name} is not implemented` });
          return;
      }
    },
    [agent, cfg, permissions, quit, session],
  );

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      setHistory((h) => [...h, text]);
      setHistIdx(-1);
      if (text.startsWith("/")) {
        await slash(text);
        return;
      }
      dispatch({ type: "user", text });
      await runPrompt(text);
    },
    [runPrompt, slash],
  );

  /* -------------------------------- keys ----------------------------- */

  useInput(
    (raw, key) => {
      // Mouse reporting (enabled while the alternate screen is active): wheel is
      // ESC[<b;x;yM. Ink strips the ESC and would otherwise type it as text, so
      // every mouse sequence is swallowed here — only the wheel scrolls.
      let str = raw;
      if (str.includes("[<")) {
        for (const m of str.matchAll(/\[<(\d+);(\d+);(\d+)([Mm])/g)) {
          const button = Number(m[1]);
          if (button === 64) wheel(-1);
          else if (button === 65) wheel(1);
        }
        str = str.replace(/\[<\d+;\d+;\d+[Mm]/g, "");
        if (!str) return;
      }

      const keylog = env("KEYLOG");
      if (keylog) {
        try {
          fs.appendFileSync(keylog, JSON.stringify({ str, key }) + "\n");
        } catch {}
      }

      if (perm) {
        const a = str.replace(/[\r\n]/g, "").toLowerCase();
        if (a.includes("y")) return answerPerm("yes");
        if (a.includes("a")) return answerPerm("always");
        if (a.includes("n") || key.escape) return answerPerm("no");
        return;
      }

      if (state.running) {
        if ((key.ctrl && str === "c") || key.escape) agent.interrupt();
        return;
      }

      if (key.ctrl && str === "c") {
        if (input) setInput("");
        else void quit();
        return;
      }
      if (key.ctrl && str === "d") {
        if (!input) void quit();
        return;
      }

      // transcript scrolling
      if (key.pageUp || (key.ctrl && str === "b")) {
        setScroll((s) => Math.min(maxScrollRef.current, s + Math.max(1, Math.floor(viewportRef.current / 2))));
        return;
      }
      if (key.pageDown || (key.ctrl && str === "f")) {
        setScroll((s) => Math.max(0, s - Math.max(1, Math.floor(viewportRef.current / 2))));
        return;
      }

      const runEnter = (value: string) => {
        if (menu.length) {
          const cmd = menu[sel]!;
          if (cmd.argumentHint) {
            setInput(completionFor(cmd));
            return;
          }
          setInput("");
          void submit(`/${cmd.name}`);
          return;
        }
        setInput("");
        void submit(value);
      };

      const nl = str.search(/[\r\n]/);
      if (nl >= 0) {
        const head = inputRef.current + str.slice(0, nl);
        const rest = str.slice(nl + 1).replace(/^[\r\n]+/, "");
        setInput(rest);
        if (head.trim() || menu.length) runEnter(head.trim());
        return;
      }

      if (menu.length) {
        if (key.upArrow || (key.ctrl && str === "p")) {
          setMenuSel((i) => (i - 1 + menu.length) % menu.length);
          return;
        }
        if (key.downArrow || (key.ctrl && str === "n")) {
          setMenuSel((i) => (i + 1) % menu.length);
          return;
        }
        if (key.tab) {
          setInput(completionFor(menu[sel]!));
          setMenuSel(0);
          return;
        }
        if (key.escape) {
          setMenuDismissed(true);
          return;
        }
      }

      if (key.return) {
        runEnter(input);
        return;
      }
      if (key.backspace || key.delete) {
        setInput((s) => s.slice(0, -1));
        setMenuDismissed(false);
        setMenuSel(0);
        return;
      }
      if (key.upArrow) {
        if (!history.length) return;
        const next = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
        setHistIdx(next);
        setInput(history[next] ?? "");
        return;
      }
      if (key.downArrow) {
        if (histIdx < 0) return;
        const next = histIdx + 1;
        if (next >= history.length) {
          setHistIdx(-1);
          setInput("");
        } else {
          setHistIdx(next);
          setInput(history[next] ?? "");
        }
        return;
      }
      if (str && !key.ctrl && !key.meta) {
        setInput((s) => s + str);
        setMenuDismissed(false);
        setMenuSel(0);
      }
    },
    { isActive: true },
  );

  /* ------------------------------- render ---------------------------- */

  const filler = Math.max(0, viewport - visible.length);

  return (
    <Box flexDirection="column" height={rows} width={cols}>
      <Box flexDirection="column" height={viewport} flexShrink={0}>
        {visible.map((line, i) => (
          <Row key={i} line={line} />
        ))}
        {Array.from({ length: filler }).map((_, i) => (
          <Text key={`f${i}`}> </Text>
        ))}
      </Box>

      {menu.length ? <Menu items={menu} selected={sel} cols={cols} /> : null}

      {perm ? <PermissionBox tool={perm.tool} input={perm.input} cols={cols} /> : null}

      <Composer value={input} running={state.running} label={busyLabel} spinner={spinner} cols={cols} />

      <Footer
        cfg={cfg}
        running={state.running}
        spinner={spinner}
        mode={permissions.mode}
        usage={state.usage}
        scroll={scrollNow}
        cols={cols}
      />
    </Box>
  );
}

/* -------------------------------- views ----------------------------- */

function Row({ line }: { line: Line }) {
  const text = line.map((s) => s.text).join("");
  if (!text) return <Text> </Text>;
  return (
    <Text wrap="truncate">
      {line.map((sp, i) => (
        <Text key={i} color={sp.color} bold={sp.bold}>
          {sp.text}
        </Text>
      ))}
    </Text>
  );
}

function Menu({ items, selected }: { items: SlashCommand[]; selected: number; cols: number }) {
  const MAX = 8;
  let start = 0;
  if (items.length > MAX) start = Math.max(0, Math.min(selected - Math.floor(MAX / 2), items.length - MAX));
  const shown = items.slice(start, start + MAX);
  const labelWidth = Math.min(26, Math.max(...shown.map((c) => displayText(c).length)) + 1);

  return (
    <Box flexDirection="column" flexShrink={0}>
      {shown.map((cmd, i) => {
        const active = start + i === selected;
        const label = displayText(cmd).padEnd(labelWidth);
        const body = active ? `${glyph.arrow} ${label}${cmd.description}` : `  ${label}${cmd.description}`;
        return (
          <Text key={cmd.name} wrap="truncate">
            <Text color={active ? p.accent : p.dim} bold={active}>
              {body}
            </Text>
          </Text>
        );
      })}
      {items.length > shown.length ? (
        <Text wrap="truncate">
          <Text color={p.faint}>{`  … ${items.length - shown.length} more · ↑/↓ scroll · tab complete`}</Text>
        </Text>
      ) : null}
    </Box>
  );
}

function borderLine(cols: number, label?: { text: string; spinner: string }): Line {
  const segments: Line = [];
  let used = 0;
  if (label) {
    segments.push({ text: ` ${label.spinner} `, color: p.accent });
    segments.push({ text: `${label.text} `, color: p.accent, bold: true });
    used = 1 + label.spinner.length + 1 + label.text.length + 1;
  }
  segments.push({ text: "─".repeat(Math.max(0, cols - used)), color: p.accentSoft });
  return segments;
}

function Composer({
  value,
  running,
  label,
  spinner,
  cols,
}: {
  value: string;
  running: boolean;
  label: string;
  spinner: string;
  cols: number;
}) {
  const prompt = " ❯ ";
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Row line={borderLine(cols, running ? { text: label, spinner } : undefined)} />
      <Text wrap="truncate">
        <Text color={p.accent} bold>
          {prompt}
        </Text>
        <Text color={p.text}>{value}</Text>
        {!running ? <Text color={p.accent}>{"▌"}</Text> : null}
      </Text>
      <Row line={borderLine(cols)} />
    </Box>
  );
}

function PermissionBox({ tool, input, cols }: { tool: Tool; input: Record<string, unknown>; cols: number }) {
  const inner = Math.max(0, cols - 4);
  const clip = (s: string) => (s.length > inner ? `${s.slice(0, Math.max(0, inner - 1))}…` : s);
  const line = (spans: Span[]): Line => {
    const text = spans.map((s) => s.text).join("");
    const pad = Math.max(0, inner - text.length);
    return [{ text: "│ ", color: p.accent }, ...spans, { text: " ".repeat(pad) + " │", color: p.accent }];
  };

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Row line={[{ text: "╭" + "─".repeat(Math.max(0, cols - 2)) + "╮", color: p.accent }]} />
      <Row
        line={line([
          { text: "? ", color: p.warn },
          { text: `run ${tool.name}`, color: p.text, bold: true },
        ])}
      />
      <Row line={line([{ text: clip(previewInput(tool, input)), color: p.dim }])} />
      <Row line={line([{ text: "y yes · a always · n no", color: p.dim }])} />
      <Row line={[{ text: "╰" + "─".repeat(Math.max(0, cols - 2)) + "╯", color: p.accent }]} />
    </Box>
  );
}

function Footer({
  cfg,
  running,
  spinner,
  mode,
  usage,
  scroll,
  cols,
}: {
  cfg: Config;
  running: boolean;
  spinner: string;
  mode: string;
  usage: Usage;
  scroll: number;
  cols: number;
}) {
  const cwd = cfg.cwd.replace(process.env.HOME ?? "", "~");
  const top = ` ${cfg.model} · ${cfg.providerName} [${cfg.formatId}] · ${cwd}`;

  const usageText = `in ${usage.inputTokens ?? 0} · out ${usage.outputTokens ?? 0}${
    usage.cost ? ` · ~$${usage.cost.toFixed(4)}` : ""
  }`;
  // the spinner lives on the composer border; the footer only names the state
  const left = running ? ` ${mode} · ${usageText}` : ` ready · ${mode} · ${usageText}`;
  const hint = scroll > 0 ? `↑${scroll} · pgdn to follow ` : "enter send · ctrl-c · /help ";
  const pad = Math.max(1, cols - left.length - hint.length);

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text wrap="truncate">
        <Text color={p.dim}>{top.length > cols ? top.slice(0, cols) : top}</Text>
      </Text>
      <Text wrap="truncate">
        <Text color={running ? p.accent : p.accentSoft}>{left}</Text>
        <Text color={p.faint}>{pad > 0 ? " ".repeat(pad) + hint : ""}</Text>
      </Text>
    </Box>
  );
}

function previewInput(tool: Tool, input: Record<string, unknown>): string {
  if (tool.name === "Bash") return String(input.command ?? "").slice(0, 80);
  if (tool.name === "Write" || tool.name === "Edit" || tool.name === "Read") return String(input.file_path ?? "");
  return Object.keys(input).join(", ");
}
