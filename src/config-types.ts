/** Shared enums that both the config loader and the tool layer need. */
export type PermissionMode = "default" | "acceptEdits" | "auto" | "plan" | "bypassPermissions";

export const PERMISSION_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "auto",
  "plan",
  "bypassPermissions",
];
