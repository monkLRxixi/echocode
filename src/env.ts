/**
 * Environment variables use the ECHOCODE_ prefix. DEEPCODE_* is still read as a
 * fallback so existing shells / CI jobs keep working after the rename.
 */
const PREFIX = "ECHOCODE";
const LEGACY = "DEEPCODE";

export function env(name: string): string | undefined {
  const v = process.env[`${PREFIX}_${name}`];
  if (v !== undefined && v !== "") return v;
  const old = process.env[`${LEGACY}_${name}`];
  return old === "" ? undefined : old;
}

export function envName(name: string): string {
  return `${PREFIX}_${name}`;
}

/** Names to show in error messages ("set A / B"). */
export function envNames(...names: string[]): string[] {
  return names.map(envName);
}
