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
