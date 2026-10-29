/**
 * Slash commands + the suggestion list that appears while you type "/".
 *
 * Rules mirror what the Claude Code bundle does (src/cc/src/1914_…js):
 *   - suggestions only while the text up to the first space looks like a command
 *   - hidden as soon as arguments start ("cmd arg", without a trailing space)
 *   - empty query: alphabetical list of everything visible
 *   - non-empty query: exact > name prefix > alias prefix > substring > description
 */

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  hidden?: boolean;
}

export const COMMANDS: SlashCommand[] = [
  { name: "help", description: "Show all commands", aliases: ["?", "h"] },
  { name: "clear", description: "Start a fresh context; the transcript on disk stays", aliases: ["reset"] },
  { name: "compact", description: "Free context by summarizing older tool results" },
  { name: "model", description: "Show or switch the model", argumentHint: "<id>", aliases: ["m"] },
  {
    name: "permissions",
    description: "Show or set the permission mode",
    argumentHint: "<mode>",
    aliases: ["perm"],
  },
  { name: "cost", description: "Tokens and estimated cost for this session", aliases: ["usage"] },
  { name: "context", description: "Message count and estimated token usage", aliases: ["ctx"] },
  { name: "session", description: "Print the session id and transcript path", aliases: ["id"] },
  { name: "tools", description: "List enabled tools and where tools.json lives" },
  { name: "exit", description: "Quit echocode", aliases: ["quit", "q"] },
];

/** "/cmd" or "/cmd " — not "/cmd arg". Mirrors `$A()` in the bundle. */
export function isSlashInput(text: string): boolean {
  if (!text.startsWith("/")) return false;
  const space = text.indexOf(" ");
  const token = space === -1 ? text.slice(1) : text.slice(1, space);
  if (!/^[a-zA-Z0-9.:_-]*$/.test(token)) return false;
  if (space !== -1 && !text.endsWith(" ")) return false;
  return true;
}

export function findCommand(text: string): SlashCommand | null {
  const token = text.trim().replace(/^\//, "").split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!token) return null;
  return (
    COMMANDS.find((c) => c.name.toLowerCase() === token) ??
    COMMANDS.find((c) => c.aliases?.some((a) => a.toLowerCase() === token)) ??
    null
  );
}

function rank(cmd: SlashCommand, q: string): number {
  const names = [cmd.name, ...(cmd.aliases ?? [])].map((n) => n.toLowerCase());
  const name = cmd.name.toLowerCase();
  if (names.some((n) => n === q)) return 0;
  if (name.startsWith(q)) return 1;
  if (names.some((n) => n.startsWith(q))) return 2;
  if (name.includes(q)) return 3;
  if (cmd.description.toLowerCase().includes(q)) return 4;
  return -1;
}

export function suggestCommands(text: string): SlashCommand[] {
  if (!isSlashInput(text)) return [];
  const query = text.slice(1).trim().toLowerCase();
  const visible = COMMANDS.filter((c) => !c.hidden);

  if (!query) return [...visible].sort((a, b) => a.name.localeCompare(b.name));

  return visible
    .map((cmd) => ({ cmd, score: rank(cmd, query) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score || a.cmd.name.localeCompare(b.cmd.name))
    .map((x) => x.cmd);
}

/** What the row looks like: "/model <id>" — `displayText` in the bundle. */
export function displayText(cmd: SlashCommand): string {
  return `/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ""}`;
}

/** Tab completion text. */
export function completionFor(cmd: SlashCommand): string {
  return `/${cmd.name}${cmd.argumentHint ? " " : ""}`;
}
