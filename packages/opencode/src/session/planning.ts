import { Effect, Schema } from "effect"
import { Tool } from "@/tool/tool"

export const PlanSchema = Schema.Struct({
  goal: Schema.String,
  files: Schema.Array(Schema.String),
  steps: Schema.Array(Schema.Struct({
    action: Schema.String,
    file: Schema.String,
    description: Schema.String,
  })),
})

export type Plan = typeof PlanSchema.Type

const plans = new Map<string, Plan>()

export const recordPlan = Effect.fn("Planning.record")(function* (input: {
  messageID: string
  sessionID: string
  goal: string
  files: string[]
  steps: Array<{ action: string; file: string; description: string }>
}) {
  plans.set(`${input.sessionID}:${input.messageID}`, {
    goal: input.goal,
    files: input.files,
    steps: input.steps,
  })
})

export const validatePlan = Effect.fn("Planning.validate")(function* (input: {
  sessionID: string
  messageID: string
  files: string[]
}) {
  const plan = plans.get(`${input.sessionID}:${input.messageID}`)
  if (!plan) return true
  const unexpected = input.files.filter((f) => !plan.files.includes(f))
  if (unexpected.length > 0) {
    yield* Effect.logWarning("planning: unexpected files modified", { files: unexpected })
  }
  return unexpected.length === 0
})

export const COMPUTER_CONTROL_INSTRUCTION = [
  "<computer_control>",
  "You have 4 computer control tools available to directly interact with the user's system:",
  "",
  "1. `computer__open` — Open files, folders, URLs, or applications (e.g. 'notepad', 'https://...', 'C:\\Users\\...')",
  "2. `computer__process` — List running processes, kill processes by name/PID, get detailed process info",
  "3. `computer__system` — Get system information: CPU load, memory usage, disk space, network interfaces",
  "4. `computer__desktop` — Desktop actions: send notifications, adjust volume, lock workstation, sleep, shutdown, restart",
  "",
  "Use these tools to automate anything on the user's computer — launch apps the user needs,",
  "check what's consuming resources, kill stuck processes, show notifications, and manage power states.",
  "You are not limited to software engineering. You are the user's personal AI assistant with direct system access.",
  "</computer_control>",
].join("\n")

export const PLANNING_INSTRUCTION = [
  "<planning>",
  "For complex multi-file tasks (refactoring, feature additions, etc.):",
  "1. First call the `plan` tool to declare: the goal, all files that will be modified, and step-by-step actions",
  "2. Then execute each step using the available tools (read, write, edit, shell)",
  "3. Only modify files that were declared in the plan",
  "If you need to modify a file not in the plan, pause and submit a revised plan first.",
  "</planning>",
].join("\n")

export * as Planning from "./planning"
