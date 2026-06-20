import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Session } from "./session"
import { SessionID, MessageID, PartID } from "./schema"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { SessionProcessor } from "./processor"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { NotFoundError } from "@/storage/storage"

import { Effect, Layer, Context, Schema } from "effect"
import * as DateTime from "effect/DateTime"
import { InstanceState } from "@/effect/instance-state"
import { isOverflow as overflow, usable } from "./overflow"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { EventV2 } from "@opencode-ai/core/event"
import { buildPrompt } from "@opencode-ai/core/session/compaction"

export const Event = {
  Compacted: EventV2.define({
    type: "session.compacted",
    schema: {
      sessionID: SessionID,
      tier: Schema.String.pipe(Schema.optional),
    },
  }),
}

export const PRUNE_MINIMUM = 20_000
export const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const PRUNE_PROTECTED_TOOLS = ["skill"]
const DEFAULT_TAIL_TURNS = 2
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000

// Multi-tier compaction thresholds
const TIER_1_THRESHOLD = 0.70  // 70% context: microcompaction (prune tool outputs)
const TIER_2_THRESHOLD = 0.85  // 85% context: light summarization
const TIER_3_THRESHOLD = 0.93  // 93% context: full summarization
const TIER_4_THRESHOLD = 0.97  // 97% context: aggressive fork-based

// Memory tier constants
const ACTIVE_WINDOW_TURNS = 3    // Always keep fully detailed
const WORKING_WINDOW_TURNS = 8   // Semi-detailed (compressed tool outputs)
const ARCHIVE_SUMMARY_TOKENS = 2_000  // Max tokens per archived summary

// Supervisor constants
const SUPERVISOR_RETRY_THRESHOLD = 3
const SUPERVISOR_COOLDOWN_MS = 30_000

type Turn = {
  start: number
  end: number
  id: MessageID
}

type Tail = {
  start: number
  id: MessageID
}

type CompletedCompaction = {
  userIndex: number
  assistantIndex: number
  summary: string | undefined
}

// --- Multi-tier compaction types ---

export type CompactionTier = "none" | "micro" | "light" | "mid" | "full" | "fork"

export type MemoryTier = "active" | "working" | "archived"

export type MemoryState = {
  activeTurns: Turn[]
  workingTurns: Turn[]
  archivedSummaries: string[]
  tier: CompactionTier
  lastCompactionSeq: number
}

export type SupervisorState = {
  consecutiveFailures: number
  lastFailureAt: number | null
  lastToolId: string | null
  strategy: "retry" | "switch-agent" | "escalate" | "skip"
  cooldownUntil: number | null
}

function summaryText(message: SessionV1.WithParts) {
  const text = message.parts
    .filter((part): part is SessionV1.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
  return text || undefined
}

function completedCompactions(messages: SessionV1.WithParts[]) {
  const users = new Map<MessageID, number>()
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (!msg.parts.some((part) => part.type === "compaction")) continue
    users.set(msg.info.id, i)
  }

  return messages.flatMap((msg, assistantIndex): CompletedCompaction[] => {
    if (msg.info.role !== "assistant") return []
    if (!msg.info.summary || !msg.info.finish || msg.info.error) return []
    const userIndex = users.get(msg.info.parentID)
    if (userIndex === undefined) return []
    return [{ userIndex, assistantIndex, summary: summaryText(msg) }]
  })
}

function preserveRecentBudget(input: { cfg: ConfigV1.Info; model: Provider.Model }) {
  return (
    input.cfg.compaction?.preserve_recent_tokens ??
    Math.min(MAX_PRESERVE_RECENT_TOKENS, Math.max(MIN_PRESERVE_RECENT_TOKENS, Math.floor(usable(input) * 0.25)))
  )
}

function turns(messages: SessionV1.WithParts[]) {
  const result: Turn[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.some((part) => part.type === "compaction")) continue
    result.push({
      start: i,
      end: messages.length,
      id: msg.info.id,
    })
  }
  for (let i = 0; i < result.length - 1; i++) {
    result[i].end = result[i + 1].start
  }
  return result
}

function splitTurn(input: {
  messages: SessionV1.WithParts[]
  turn: Turn
  model: Provider.Model
  budget: number
  estimate: (input: { messages: SessionV1.WithParts[]; model: Provider.Model }) => Effect.Effect<number>
}) {
  return Effect.gen(function* () {
    if (input.budget <= 0) return undefined
    if (input.turn.end - input.turn.start <= 1) return undefined
    for (let start = input.turn.start + 1; start < input.turn.end; start++) {
      const size = yield* input.estimate({
        messages: input.messages.slice(start, input.turn.end),
        model: input.model,
      })
      if (size > input.budget) continue
      return {
        start,
        id: input.messages[start]!.info.id,
      } satisfies Tail
    }
    return undefined
  })
}

export interface Interface {
  readonly isOverflow: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
  }) => Effect.Effect<boolean>
  readonly prune: (input: { sessionID: SessionID }) => Effect.Effect<void>
  readonly process: (input: {
    parentID: MessageID
    messages: SessionV1.WithParts[]
    sessionID: SessionID
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<"continue" | "stop">
  readonly create: (input: {
    sessionID: SessionID
    agent: string
    model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
    auto: boolean
    overflow?: boolean
  }) => Effect.Effect<void>
  readonly selectTier: (input: {
    tokens: SessionV1.Assistant["tokens"]
    model: Provider.Model
    messages: SessionV1.WithParts[]
  }) => Effect.Effect<CompactionTier>
  readonly microCompact: (input: { sessionID: SessionID }) => Effect.Effect<boolean>
  readonly checkSupervisor: (input: {
    toolId: string
    toolName: string
    error: string
  }) => Effect.Effect<SupervisorState["strategy"]>
  readonly resetSupervisor: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCompaction") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const agents = yield* Agent.Service
    const plugin = yield* Plugin.Service
    const processors = yield* SessionProcessor.Service
    const provider = yield* Provider.Service
    const events = yield* EventV2Bridge.Service
    const flags = yield* RuntimeFlags.Service

    const isOverflow = Effect.fn("SessionCompaction.isOverflow")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      return overflow({
        cfg: yield* config.get(),
        tokens: input.tokens,
        model: input.model,
        outputTokenMax: flags.outputTokenMax,
      })
    })

    const estimate = Effect.fn("SessionCompaction.estimate")(function* (input: {
      messages: SessionV1.WithParts[]
      model: Provider.Model
    }) {
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model)
      return Token.estimate(JSON.stringify(msgs))
    })

    const select = Effect.fn("SessionCompaction.select")(function* (input: {
      messages: SessionV1.WithParts[]
      cfg: ConfigV1.Info
      model: Provider.Model
    }) {
      const limit = input.cfg.compaction?.tail_turns ?? DEFAULT_TAIL_TURNS
      if (limit <= 0) return { head: input.messages, tail_start_id: undefined }
      const budget = preserveRecentBudget({ cfg: input.cfg, model: input.model })
      const all = turns(input.messages)
      if (!all.length) return { head: input.messages, tail_start_id: undefined }
      const recent = all.slice(-limit)
      const sizes = yield* Effect.forEach(
        recent,
        (turn) =>
          estimate({
            messages: input.messages.slice(turn.start, turn.end),
            model: input.model,
          }),
        { concurrency: 1 },
      )

      let total = 0
      let keep: Tail | undefined
      for (let i = recent.length - 1; i >= 0; i--) {
        const turn = recent[i]!
        const size = sizes[i]
        if (total + size <= budget) {
          total += size
          keep = { start: turn.start, id: turn.id }
          continue
        }
        const remaining = budget - total
        const split = yield* splitTurn({
          messages: input.messages,
          turn,
          model: input.model,
          budget: remaining,
          estimate,
        })
        if (split) keep = split
        else if (!keep) {
          yield* Effect.logInfo("tail fallback", { budget, size, total })
        }
        break
      }

      if (!keep || keep.start === 0) return { head: input.messages, tail_start_id: undefined }
      return {
        head: input.messages.slice(0, keep.start),
        tail_start_id: keep.id,
      }
    })

    // --- Multi-tier compaction engine ---

    const usageRatio = Effect.fn("SessionCompaction.usageRatio")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
    }) {
      const cfg = yield* config.get()
      const usable_ = usable({ cfg, model: input.model, outputTokenMax: flags.outputTokenMax })
      if (usable_ <= 0) return 0
      const count =
        input.tokens.total ||
        input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
      return count / usable_
    })

    const selectTier = Effect.fn("SessionCompaction.selectTier")(function* (input: {
      tokens: SessionV1.Assistant["tokens"]
      model: Provider.Model
      messages: SessionV1.WithParts[]
    }) {
      const ratio = yield* usageRatio({ tokens: input.tokens, model: input.model })
      if (ratio >= TIER_4_THRESHOLD) return "fork"
      if (ratio >= TIER_3_THRESHOLD) return "full"
      if (ratio >= TIER_2_THRESHOLD) return "mid"
      if (ratio >= TIER_1_THRESHOLD) return "light"
      // Check if microcompaction would help even below tier 1
      const toolParts = input.messages.flatMap((m) =>
        m.parts.filter((p): p is SessionV1.ToolPart => p.type === "tool" && p.state.status === "completed" && !p.state.time.compacted),
      )
      if (toolParts.length > 5) return "micro"
      return "none"
    })

    const microCompact = Effect.fn("SessionCompaction.microCompact")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return false
      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return false

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < ACTIVE_WINDOW_TURNS) continue
        if (msg.info.role === "assistant" && msg.info.summary) break
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) continue
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT && turns <= WORKING_WINDOW_TURNS) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("microCompact", { pruned, total, count: toPrune.length })
      if (pruned <= 0) return false
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          yield* session.updatePart(part)
        }
      }
      return true
    })

    // Aggressive prune that strips old tool outputs and reasoning content
    const aggressivePrune = Effect.fn("SessionCompaction.aggressivePrune")(function* (input: { sessionID: SessionID }) {
      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return false

      let pruned = 0
      let turns = 0
      const toolUpdates: SessionV1.ToolPart[] = []

      for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns <= ACTIVE_WINDOW_TURNS) continue
        if (msg.info.role === "assistant" && msg.info.summary) break

        // Strip reasoning content from old messages
        if (msg.info.role === "assistant" && turns > ACTIVE_WINDOW_TURNS + 1) {
          for (const part of msg.parts) {
            if (part.type === "reasoning" && part.text) {
              const text = part.text
              ;(part as any).text = `[reasoning: ${Token.estimate(text)} tokens]`
              pruned += Token.estimate(text)
            }
          }
        }

        // Aggressively prune tool outputs
        for (const part of msg.parts) {
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) continue
          part.state.time.compacted = Date.now()
          toolUpdates.push(part)
          pruned += Token.estimate(part.state.output)
        }
      }

      for (const part of toolUpdates) {
        yield* session.updatePart(part)
      }

      yield* Effect.logInfo("aggressivePrune", { pruned, toolCount: toolUpdates.length })
      return pruned > PRUNE_MINIMUM
    })

    // --- Supervisor state ---

    let supervisorState: SupervisorState = {
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastToolId: null,
      strategy: "retry",
      cooldownUntil: null,
    }

    const resetSupervisor = Effect.fn("SessionCompaction.resetSupervisor")(function* () {
      supervisorState = {
        consecutiveFailures: 0,
        lastFailureAt: null,
        lastToolId: null,
        strategy: "retry",
        cooldownUntil: null,
      }
    })

    const checkSupervisor = Effect.fn("SessionCompaction.checkSupervisor")(function* (input: {
      toolId: string
      toolName: string
      error: string
    }) {
      const now = Date.now()

      // Cooldown check
      if (supervisorState.cooldownUntil && now < supervisorState.cooldownUntil) {
        return supervisorState.strategy
      }

      // Same tool failure
      if (input.toolId === supervisorState.lastToolId) {
        supervisorState.consecutiveFailures++
      } else {
        supervisorState.consecutiveFailures = 1
        supervisorState.lastToolId = input.toolId
      }

      supervisorState.lastFailureAt = now

      if (supervisorState.consecutiveFailures >= SUPERVISOR_RETRY_THRESHOLD * 2) {
        supervisorState.strategy = "skip"
        supervisorState.cooldownUntil = now + SUPERVISOR_COOLDOWN_MS * 2
        yield* Effect.logWarning("supervisor: escalating to skip", { tool: input.toolName, failures: supervisorState.consecutiveFailures })
      } else if (supervisorState.consecutiveFailures >= SUPERVISOR_RETRY_THRESHOLD) {
        supervisorState.strategy = "switch-agent"
        supervisorState.cooldownUntil = now + SUPERVISOR_COOLDOWN_MS
        yield* Effect.logWarning("supervisor: switching agent strategy", { tool: input.toolName, failures: supervisorState.consecutiveFailures })
      } else {
        supervisorState.strategy = "retry"
      }

      return supervisorState.strategy
    })

    // goes backwards through parts until there are PRUNE_PROTECT tokens worth of tool
    // calls, then erases output of older tool calls to free context space
    const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
      const cfg = yield* config.get()
      if (!cfg.compaction?.prune) return
      yield* Effect.logInfo("pruning")
      // Try micro compaction first (non-destructive, fast)
      const didMicro = yield* microCompact({ sessionID: input.sessionID })

      const msgs = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
      if (!msgs) return

      let total = 0
      let pruned = 0
      const toPrune: SessionV1.ToolPart[] = []
      let turns = 0

      loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
        const msg = msgs[msgIndex]
        if (msg.info.role === "user") turns++
        if (turns < 2) continue
        if (msg.info.role === "assistant" && msg.info.summary) break loop
        for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
          const part = msg.parts[partIndex]
          if (part.type !== "tool") continue
          if (part.state.status !== "completed") continue
          if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
          if (part.state.time.compacted) break loop
          const estimate = Token.estimate(part.state.output)
          total += estimate
          if (total <= PRUNE_PROTECT) continue
          pruned += estimate
          toPrune.push(part)
        }
      }

      yield* Effect.logInfo("found", { pruned, total })
      if (pruned > PRUNE_MINIMUM) {
        for (const part of toPrune) {
          if (part.state.status === "completed") {
            part.state.time.compacted = Date.now()
            yield* session.updatePart(part)
          }
        }
        yield* Effect.logInfo("pruned", { count: toPrune.length })
      }
    })

    const processCompaction = Effect.fn("SessionCompaction.process")(function* (input: {
      parentID: MessageID
      messages: SessionV1.WithParts[]
      sessionID: SessionID
      auto: boolean
      overflow?: boolean
    }) {
      // Determine appropriate compaction tier
      const lastAssistant = input.messages.findLast((m): m is SessionV1.WithParts & { info: SessionV1.Assistant } =>
        m.info.role === "assistant" && m.info.finish !== undefined,
      )
      let compactionTier: CompactionTier = "mid"
      if (lastAssistant) {
        const model = lastAssistant.info.modelID
          ? yield* provider.getModel(lastAssistant.info.providerID, lastAssistant.info.modelID).pipe(
              Effect.catchIf(Provider.ModelNotFoundError.isInstance, () => Effect.succeed(undefined as Provider.Model | undefined)),
            )
          : undefined
        if (model) {
          compactionTier = yield* selectTier({
            tokens: lastAssistant.info.tokens,
            model,
            messages: input.messages,
          })
        }
      }

      yield* Effect.logInfo("compaction: selected tier", {
        tier: compactionTier,
        auto: input.auto,
        overflow: input.overflow,
      })

      // Tier 0: Microcompaction - just prune tool outputs and return
      if (compactionTier === "micro") {
        const didPrune = yield* microCompact({ sessionID: input.sessionID })
        if (didPrune) return "continue"
        // Fall through to at least light if micro didn't help
      }

      // Tier 1: Light compaction - aggressive prune + strip reasoning
      if (compactionTier === "light") {
        const didPrune = yield* aggressivePrune({ sessionID: input.sessionID })
        if (didPrune && input.auto) return "continue"
        // Fall through to mid if light wasn't enough
      }

      const parent = input.messages.findLast((m) => m.info.id === input.parentID)
      if (!parent || parent.info.role !== "user") {
        throw new Error(`Compaction parent must be a user message: ${input.parentID}`)
      }
      const userMessage = parent.info
      const compactionPart = parent.parts.find((part): part is SessionV1.CompactionPart => part.type === "compaction")

      let messages = input.messages
      let replay:
        | {
            info: SessionV1.User
            parts: SessionV1.Part[]
          }
        | undefined
      if (input.overflow) {
        const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
        for (let i = idx - 1; i >= 0; i--) {
          const msg = input.messages[i]
          if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
            replay = { info: msg.info, parts: msg.parts }
            messages = input.messages.slice(0, i)
            break
          }
        }
        const hasContent =
          replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
        if (!hasContent) {
          replay = undefined
          messages = input.messages
        }
      }

      const agent = yield* agents.get("compaction")
      const model = agent.model
        ? yield* provider.getModel(agent.model.providerID, agent.model.modelID).pipe(Effect.orDie)
        : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID).pipe(Effect.orDie)
      const cfg = yield* config.get()
      const history = compactionPart && messages.at(-1)?.info.id === input.parentID ? messages.slice(0, -1) : messages
      const prior = completedCompactions(history)
      const hidden = new Set(prior.flatMap((item) => [item.userIndex, item.assistantIndex]))
      const previousSummary = prior.at(-1)?.summary
      const selected = yield* select({
        messages: history.filter((_, index) => !hidden.has(index)),
        cfg,
        model,
      })
      // Allow plugins to inject context or replace compaction prompt.
      const compacting = yield* plugin.trigger(
        "experimental.session.compacting",
        { sessionID: input.sessionID },
        { context: [], prompt: undefined },
      )
      const nextPrompt = compacting.prompt ?? buildPrompt({ previousSummary, context: compacting.context })
      const msgs = structuredClone(selected.head)
      yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
      const modelMessages = yield* MessageV2.toModelMessagesEffect(msgs, model, {
        stripMedia: true,
        toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
      })
      const tailIndex = selected.tail_start_id
        ? history.findIndex((message) => message.info.id === selected.tail_start_id)
        : -1
      const recent =
        tailIndex < 0
          ? ""
          : JSON.stringify(
              yield* MessageV2.toModelMessagesEffect(history.slice(tailIndex), model, {
                stripMedia: true,
                toolOutputMaxChars: TOOL_OUTPUT_MAX_CHARS,
              }),
            )
      const ctx = yield* InstanceState.context
      const msg: SessionV1.Assistant = {
        id: MessageID.ascending(),
        role: "assistant",
        parentID: input.parentID,
        sessionID: input.sessionID,
        mode: "compaction",
        agent: "compaction",
        variant: userMessage.model.variant,
        summary: true,
        path: {
          cwd: ctx.directory,
          root: ctx.worktree,
        },
        cost: 0,
        tokens: {
          output: 0,
          input: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: model.id,
        providerID: model.providerID,
        time: {
          created: Date.now(),
        },
      }
      yield* session.updateMessage(msg)
      const processor = yield* processors.create({
        assistantMessage: msg,
        sessionID: input.sessionID,
        model,
      })
      const result = yield* processor.process({
        user: userMessage,
        agent,
        sessionID: input.sessionID,
        tools: {},
        system: [],
        messages: [
          ...modelMessages,
          {
            role: "user",
            content: [{ type: "text", text: nextPrompt }],
          },
        ],
        model,
      })

      if (result === "compact") {
        processor.message.error = new SessionV1.ContextOverflowError({
          message: replay
            ? "Conversation history too large to compact - exceeds model context limit"
            : "Session too large to compact - context exceeds model limit even after stripping media",
        }).toObject()
        processor.message.finish = "error"
        yield* session.updateMessage(processor.message)
        return "stop"
      }

      if (compactionPart && selected.tail_start_id && compactionPart.tail_start_id !== selected.tail_start_id) {
        yield* session.updatePart({
          ...compactionPart,
          tail_start_id: selected.tail_start_id,
        })
      }

      if (result === "continue" && input.auto) {
        if (replay) {
          const original = replay.info
          const replayMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: input.sessionID,
            time: { created: Date.now() },
            agent: original.agent,
            model: original.model,
            format: original.format,
            tools: original.tools,
            system: original.system,
          })
          for (const part of replay.parts) {
            if (part.type === "compaction") continue
            const replayPart =
              part.type === "file" && MessageV2.isMedia(part.mime)
                ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
                : part
            yield* session.updatePart({
              ...replayPart,
              id: PartID.ascending(),
              messageID: replayMsg.id,
              sessionID: input.sessionID,
            })
          }
        }

        if (!replay) {
          const info = yield* provider.getProvider(userMessage.model.providerID)
          if (
            (yield* plugin.trigger(
              "experimental.compaction.autocontinue",
              {
                sessionID: input.sessionID,
                agent: userMessage.agent,
                model: yield* provider
                  .getModel(userMessage.model.providerID, userMessage.model.modelID)
                  .pipe(Effect.orDie),
                provider: {
                  source: info.source,
                  info,
                  options: info.options,
                },
                message: userMessage,
                overflow: input.overflow === true,
              },
              { enabled: true },
            )).enabled
          ) {
            const continueMsg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: input.sessionID,
              time: { created: Date.now() },
              agent: userMessage.agent,
              model: userMessage.model,
            })
            const text =
              (input.overflow
                ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
                : "") +
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: continueMsg.id,
              sessionID: input.sessionID,
              type: "text",
              // Internal marker for auto-compaction followups so provider plugins
              // can distinguish them from manual post-compaction user prompts.
              // This is not a stable plugin contract and may change or disappear.
              metadata: { compaction_continue: true },
              synthetic: true,
              text,
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }
        }
      }

      // Reset supervisor on successful compaction
      yield* resetSupervisor()

      if (processor.message.error) return "stop"
      if (result === "continue") {
        const summary = summaryText(
          (yield* session.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).find(
            (item) => item.info.id === msg.id,
          ) ?? {
            info: msg,
            parts: [],
          },
        )
        if (flags.experimentalEventSystem) {
          if (summary)
            yield* events.publish(SessionEvent.Compaction.Ended, {
              sessionID: input.sessionID,
              messageID: SessionMessage.ID.make(input.parentID),
              timestamp: DateTime.makeUnsafe(Date.now()),
              reason: input.auto ? "auto" : "manual",
              text: summary ?? "",
              recent,
            })
        }
        yield* events.publish(Event.Compacted, { sessionID: input.sessionID, tier: compactionTier })
      }
      return result
    })

    const create = Effect.fn("SessionCompaction.create")(function* (input: {
      sessionID: SessionID
      agent: string
      model: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
      auto: boolean
      overflow?: boolean
    }) {
      const msg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
      if (flags.experimentalEventSystem) {
        yield* events.publish(SessionEvent.Compaction.Started, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.make(msg.id),
          timestamp: DateTime.makeUnsafe(Date.now()),
          reason: input.auto ? "auto" : "manual",
        })
      }
    })

    return Service.of({
      isOverflow,
      prune,
      process: processCompaction,
      create,
      selectTier,
      microCompact,
      checkSupervisor,
      resetSupervisor,
    })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(SessionProcessor.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(RuntimeFlags.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
)

export const node = LayerNode.make(layer, [
  Config.node,
  Session.node,
  Agent.node,
  Plugin.node,
  SessionProcessor.node,
  Provider.node,
  EventV2Bridge.node,
  RuntimeFlags.node,
])

export * as SessionCompaction from "./compaction"
