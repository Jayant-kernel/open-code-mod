import { Effect, Schema } from "effect"
import { execSync } from "child_process"
import os from "os"
import * as Tool from "./tool"

function run(cmd: string, timeoutMs = 15_000): Effect.Effect<string> {
  return Effect.sync(() => execSync(cmd, { encoding: "utf8", timeout: timeoutMs }).trim()).pipe(
    Effect.catch(() => Effect.succeed("")),
  )
}

const POWERSHELL = "powershell -NoProfile -NonInteractive -Command"

function pwsh(script: string, timeoutMs = 15_000): Effect.Effect<string> {
  return run(`${POWERSHELL} "${script.replace(/"/g, '\\"')}"`, timeoutMs)
}

const OpenParameters = Schema.Struct({
  target: Schema.String.annotate({ description: "File path, folder, URL, or application name to open (e.g. 'notepad', 'https://...', 'C:\\Users\\...', 'README.md')" }),
})

export const ComputerOpenTool = Tool.define(
  "computer__open",
  Effect.gen(function* () {
    return {
      description: [
        "Open a file, folder, URL, or application on the user's system.",
        "Examples:",
        '  target: "https://google.com"  → opens in default browser',
        '  target: "notepad.exe"         → launches Notepad',
        '  target: "C:\\Users\\..."      → opens File Explorer',
        '  target: "spotify"             → launches Spotify',
        '  target: "README.md"           → opens with default editor',
      ].join("\n"),
      parameters: OpenParameters,
      execute: (params: Schema.Schema.Type<typeof OpenParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const safe = params.target.replace(/"/g, '\\"')
          if (process.platform === "win32") {
            yield* pwsh(`Start-Process "${safe}"`, 10_000)
          } else {
            const opener = os.type() === "Darwin" ? "open" : "xdg-open"
            yield* run(`${opener} "${safe}"`, 10_000)
          }
          return { title: "Opened", metadata: {}, output: `Opened: ${params.target}` }
        }),
    } satisfies Tool.DefWithoutID
  }),
)

const ProcessParameters = Schema.Struct({
  action: Schema.Literals(["list", "kill", "info"]).annotate({ description: "list → running processes. kill → terminate by name/PID. info → detailed info by name/PID." }),
  name: Schema.optional(Schema.String.annotate({ description: "Process name (e.g. 'chrome', 'notepad') or PID" })),
})

export const ComputerProcessTool = Tool.define(
  "computer__process",
  Effect.gen(function* () {
    return {
      description: "List, inspect, or terminate processes.",
      parameters: ProcessParameters,
      execute: (params: Schema.Schema.Type<typeof ProcessParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.action === "list") {
            const raw = process.platform === "win32"
              ? yield* pwsh("Get-Process | Select-Object Name,Id,CPU,PM | ConvertTo-Json -Compress")
              : yield* run("ps aux --sort=-%cpu | head -40")
            return { title: "Process list", metadata: {}, output: raw || "No processes" }
          }
          if (params.action === "kill") {
            if (!params.name) return { title: "Error", metadata: {}, output: "name required" }
            if (process.platform === "win32") {
              yield* pwsh(`Stop-Process -Name "${params.name}" -Force -ErrorAction SilentlyContinue`)
              yield* pwsh(`Stop-Process -Id "${params.name}" -Force -ErrorAction SilentlyContinue`)
            } else {
              yield* run(`kill -9 ${params.name} 2>/dev/null ; pkill -9 -f "${params.name}" 2>/dev/null`, 5_000)
            }
            return { title: "Killed", metadata: {}, output: `Killed: ${params.name}` }
          }
          if (params.action === "info") {
            if (!params.name) return { title: "Error", metadata: {}, output: "name required" }
            const raw = process.platform === "win32"
              ? yield* pwsh(`Get-Process -Name "${params.name}" -ErrorAction SilentlyContinue | Select-Object * | ConvertTo-Json -Compress`)
              : yield* run(`ps -p ${params.name} -o pid,ppid,pcpu,pmem,rss,comm --no-headers 2>/dev/null || ps aux | grep -v grep | grep "${params.name}"`)
            return { title: "Process info", metadata: {}, output: raw || `Not found: ${params.name}` }
          }
          return { title: "Invalid", metadata: {}, output: "Unknown action" }
        }),
    } satisfies Tool.DefWithoutID
  }),
)

const SystemParameters = Schema.Struct({
  category: Schema.Literals(["cpu", "memory", "disk", "network", "all"]).annotate({ description: "Which system info category" }),
})

export const ComputerSystemTool = Tool.define(
  "computer__system",
  Effect.gen(function* () {
    return {
      description: "Get system information — CPU load, memory usage, disk space, network interfaces.",
      parameters: SystemParameters,
      execute: (params: Schema.Schema.Type<typeof SystemParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const lines: string[] = []
          if (params.category === "cpu" || params.category === "all") {
            if (process.platform === "win32") {
              const r = yield* pwsh("Get-CimInstance Win32_Processor | Select-Object Name,MaxClockSpeed,NumberOfCores,NumberOfLogicalProcessors,LoadPercentage | ConvertTo-Json -Compress")
              lines.push(`CPU: ${r}`)
            } else {
              const r = yield* run("cat /proc/loadavg")
              lines.push(`CPU Load: ${r} (${os.cpus().length} cores)`)
            }
          }
          if (params.category === "memory" || params.category === "all") {
            const total = os.totalmem()
            const free = os.freemem()
            lines.push(`Memory: ${((total - free) / 1e9).toFixed(1)}GB / ${(total / 1e9).toFixed(1)}GB (${((total - free) / total * 100).toFixed(1)}%)`)
          }
          if ((params.category === "disk" || params.category === "all") && process.platform === "win32") {
            const r = yield* pwsh("Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress")
            lines.push(`Disks: ${r}`)
          }
          if (params.category === "network" || params.category === "all") {
            const ifaces = Object.entries(os.networkInterfaces()).flatMap(([name, addrs]) =>
              (addrs ?? []).map((a) => `${name}: ${a.address} (${a.family})`),
            )
            lines.push(`Network:\n  ${ifaces.join("\n  ")}`)
          }
          return { title: "System info", metadata: {}, output: lines.join("\n") }
        }),
    } satisfies Tool.DefWithoutID
  }),
)

const DesktopParameters = Schema.Struct({
  action: Schema.Literals(["notify", "volume", "lock", "sleep", "shutdown", "restart"]).annotate({ description: "Desktop action" }),
  message: Schema.optional(Schema.String.annotate({ description: "Notification message" })),
  title: Schema.optional(Schema.String.annotate({ description: "Notification title" })),
  level: Schema.optional(Schema.Number.annotate({ description: "Volume 0-100" })),
})

export const ComputerDesktopTool = Tool.define(
  "computer__desktop",
  Effect.gen(function* () {
    return {
      description: "Desktop actions: notifications, volume control, lock, sleep, shutdown, restart.",
      parameters: DesktopParameters,
      execute: (params: Schema.Schema.Type<typeof DesktopParameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (params.action === "notify") {
            const msg = (params.message ?? "Notification from opencode").replace(/"/g, '\\"')
            const ttl = (params.title ?? "opencode").replace(/"/g, '\\"')
            if (process.platform === "win32") {
              yield* pwsh(`[System.Windows.Forms.MessageBox]::Show('${msg.replace(/'/g, "''")}','${ttl.replace(/'/g, "''")}')`).pipe(Effect.catch(() => Effect.void))
            } else {
              yield* run(`notify-send "${ttl}" "${msg}"`, 5_000).pipe(Effect.catch(() => Effect.void))
            }
            return { title: "Notified", metadata: {}, output: `Notification: ${msg}` }
          }
          if (params.action === "volume") {
            if (process.platform === "win32") {
              yield* pwsh("(New-Object -ComObject WScript.Shell).SendKeys([char]173)")
            } else {
              yield* run(`pactl set-sink-volume @DEFAULT_SINK@ ${params.level ?? 50}% 2>/dev/null`, 5_000)
            }
            return { title: "Volume", metadata: {}, output: `Volume: ${params.level ?? 50}` }
          }
          if (params.action === "lock") {
            process.platform === "win32"
              ? yield* pwsh("(New-Object -ComObject WScript.Shell).Run('rundll32.exe user32.dll,LockWorkStation')")
              : yield* run("xdg-screensaver lock 2>/dev/null || loginctl lock-session 2>/dev/null", 5_000)
            return { title: "Locked", metadata: {}, output: "Workstation locked" }
          }
          if (params.action === "sleep") {
            if (process.platform === "win32") yield* pwsh("(New-Object -ComObject WScript.Shell).Run('rundll32.exe powrprof.dll,SetSuspendState Sleep')")
            return { title: "Sleep", metadata: {}, output: "System sleeping" }
          }
          if (params.action === "shutdown") {
            if (process.platform === "win32") yield* pwsh("Stop-Computer -Force")
            return { title: "Shutdown", metadata: {}, output: "System shutting down" }
          }
          if (params.action === "restart") {
            if (process.platform === "win32") yield* pwsh("Restart-Computer -Force")
            return { title: "Restart", metadata: {}, output: "System restarting" }
          }
          return { title: "Invalid", metadata: {}, output: `Unknown: ${params.action}` }
        }),
    } satisfies Tool.DefWithoutID
  }),
)
