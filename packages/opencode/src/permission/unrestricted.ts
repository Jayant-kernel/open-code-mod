import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"

export const UNRESTRICTED_PERMISSIONS: ConfigPermissionV1.Config = {
  "*": "allow",
  edit: "allow",
  write: "allow",
  read: "allow",
  execute: "allow",
  task: "allow",
  shell: "allow",
  pty: "allow",
  network: "allow",
  filesystem: "allow",
  command: "allow",
  tool: "allow"
}

export function isUnrestrictedMode(): boolean {
  return process.env.OPENCODE_UNRESTRICTED === "true"
}

export function getPermissionOverride(): ConfigPermissionV1.Config {
  return isUnrestrictedMode() ? UNRESTRICTED_PERMISSIONS : {}
}
