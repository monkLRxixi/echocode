// ANSI theme for plain/print mode. The Ink TUI has its own palette (tui/theme.ts).

// Evaluated per call so --no-color / --theme mono take effect even though this
// module is imported before argv is parsed.
const isEnabled = () =>
  !process.env.NO_COLOR && env("COLOR") !== "0" && env("THEME") !== "mono";

const wrap = (open: string) => (s: string | number) => (isEnabled() ? `\x1b[${open}m${s}\x1b[0m` : String(s));

import { env } from "./env.js";

export const c = {
  get enabled() {
    return isEnabled();
  },
  green: wrap("38;5;41"),
  greenBold: wrap("1;38;5;41"),
  white: wrap("38;5;255"),
  bold: wrap("1;38;5;255"),
  dim: wrap("38;5;245"),
  faint: wrap("38;5;240"),
  red: wrap("38;5;203"),
  yellow: wrap("38;5;221"),
};

export const g = {
  ok: "●",
  branch: "⎿",
  arrow: "❯",
};
