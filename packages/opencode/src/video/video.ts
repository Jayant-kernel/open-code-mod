import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Effect, Layer, Schema } from "effect"
import { execSync } from "child_process"
import fs from "fs"
import path from "path"
import os from "os"

export class FfmpegUnavailableError extends Schema.TaggedErrorClass<FfmpegUnavailableError>()(
  "FfmpegUnavailableError",
  {},
) {
  override get message() {
    return "ffmpeg/ffprobe is not available on this system"
  }
}

export class VideoDecodeError extends Schema.TaggedErrorClass<VideoDecodeError>()("VideoDecodeError", {
  detail: Schema.String,
}) {
  override get message() {
    return `Failed to process video: ${this.detail}`
  }
}

export type Error = FfmpegUnavailableError | VideoDecodeError

export type ExtractResult = {
  metadata: string
  thumbnailPath?: string
  thumbnailMime: string
}

export interface Interface {
  readonly extract: (input: { filePath: string; mime: string }) => Effect.Effect<ExtractResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Video") {}

function checkFfmpeg(): boolean {
  try {
    execSync("ffprobe -version", { encoding: "utf8", timeout: 5000 })
    return true
  } catch {
    return false
  }
}

function run(cmd: string, timeoutMs = 15_000): string {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: timeoutMs }).trim()
  } catch {
    return ""
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const available = yield* Effect.sync(() => checkFfmpeg())

    const extract = Effect.fn("Video.extract")(function* (input: { filePath: string; mime: string }) {
      if (!available) return { metadata: "", thumbnailPath: undefined, thumbnailMime: "image/jpeg" }

      const lines: string[] = []
      const raw = run(`ffprobe -v quiet -print_format json -show_format -show_streams "${input.filePath}"`, 10_000)
      if (raw) {
        try {
          const data = JSON.parse(raw)
          const format = data.format
          if (format) {
            lines.push(`Duration: ${format.duration ? `${Math.round(parseFloat(format.duration))}s` : "unknown"}`)
            if (format.size) lines.push(`Size: ${(parseInt(format.size) / 1e6).toFixed(1)} MB`)
            if (format.bit_rate) lines.push(`Bitrate: ${Math.round(parseInt(format.bit_rate) / 1000)} kbps`)
          }
          const videoStream = data.streams?.find((s: any) => s.codec_type === "video")
          if (videoStream) {
            lines.push(`Resolution: ${videoStream.width}x${videoStream.height}`)
            lines.push(`Codec: ${videoStream.codec_name}`)
            if (videoStream.r_frame_rate) {
              const [num, den] = videoStream.r_frame_rate.split("/")
              lines.push(`FPS: ${den && parseInt(den) ? Math.round(parseInt(num) / parseInt(den)) : num}`)
            }
          }
          const audioStream = data.streams?.find((s: any) => s.codec_type === "audio")
          if (audioStream) lines.push(`Audio: ${audioStream.codec_name} (${audioStream.channels ?? "?"}ch)`)
        } catch {
          lines.push("Could not parse video metadata")
        }
      } else {
        lines.push("Could not read video metadata")
      }

      let thumbnailPath: string | undefined
      const ext = path.extname(input.filePath).toLowerCase()
      if (["mp4", "webm", "mov", "avi", "mkv", "m4v", "3gp"].includes(ext.replace(".", ""))) {
        const tmpFile = path.join(os.tmpdir(), `opencode-video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`)
        const result = run(`ffmpeg -i "${input.filePath}" -vframes 1 -q:v 2 -y "${tmpFile}" 2>&1`, 30_000)
        if (result !== null && fs.existsSync(tmpFile)) {
          const stat = fs.statSync(tmpFile)
          if (stat.size > 0) thumbnailPath = tmpFile
        }
      }

      return {
        metadata: lines.length ? lines.join("\n") : "",
        thumbnailPath,
        thumbnailMime: "image/jpeg",
      }
    })

    return Service.of({ extract })
  }),
)

export const defaultLayer = layer

export const node = LayerNode.make(layer, [])

export * as Video from "./video"
