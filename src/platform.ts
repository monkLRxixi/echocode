import os from "node:os";

export const isWindows = process.platform === "win32";

/** Home directory, or "" when the platform cannot tell us. */
export function homeDir(): string {
  try {
    return os.homedir();
  } catch {
    return process.env.HOME ?? process.env.USERPROFILE ?? "";
  }
}

/** `O:\git-project\echocode` -> `~/git-project/echocode` (case-insensitive on Windows). */
export function displayPath(p: string): string {
  const home = homeDir();
  if (home && p) {
    const norm = (s: string) => (isWindows ? s.toLowerCase() : s);
    if (norm(p).startsWith(norm(home))) {
      const rest = p.slice(home.length).replace(/\\/g, "/");
      return rest ? `~${rest}` : "~";
    }
  }
  return p;
}

/** CRLF / lone CR -> LF, so wrapped rows and diffs behave the same everywhere. */
export function normalizeNewlines(s: string): string {
  return s.includes("\r") ? s.replace(/\r\n?/g, "\n") : s;
}
