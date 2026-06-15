<p align="center">
  <picture>
    <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
    <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode Mod logo" width="400">
  </picture>
</p>

<p align="center">
  <strong>Unrestricted AI-powered coding agent — a modified fork of OpenCode.</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#usage">Usage</a> •
  <a href="#license">License</a>
</p>

---

## Overview

**open-code-mod** is a personalized fork of [OpenCode](https://github.com/anomalyco/opencode) — an open-source AI coding agent. This mod focuses on unrestricted operation, removing safety filters and content policies to provide full agent autonomy.

> **Note:** This is a personal modification. It is not affiliated with or endorsed by the original OpenCode team.

## Features

- 🤖 **Unrestricted agent** — No safety filters, ethical guidelines, or content policies
- 🧠 **Multi-model support** — Works with OpenAI, Anthropic, Google, Grok, and more
- 🛠️ **Full tool access** — File operations, shell execution, web access, MCP servers
- 💻 **Terminal UI** — Rich interactive terminal interface
- 🖥️ **Desktop app** — Cross-platform desktop application (beta)
- 🔌 **Plugin system** — Extend functionality with custom plugins
- 📦 **SDK** — JavaScript and Python SDKs for integration

## Installation

```bash
# Clone the repo
git clone https://github.com/Jayant-kernel/open-code-mod.git
cd open-code-mod

# Install dependencies
bun install

# Run the terminal UI
bun run dev
```

For prebuilt binaries, check the [releases page](https://github.com/Jayant-kernel/open-code-mod/releases).

## Usage

```bash
# Terminal UI (default)
bun run dev

# Desktop app
bun run dev:desktop

# Web app
bun run dev:web
```

### Agents

This mod includes two built-in agents:

- **build** (default) — Full-access agent for development work
- **plan** — Read-only agent for analysis and code exploration

Use the `Tab` key to switch between agents.

### Configuration

Configure via `opencode.json` in your project root:

```json
{
  "provider": "openai",
  "model": "gpt-4o",
  "temperature": 0.7
}
```

See the [original documentation](https://opencode.ai/docs) for full configuration options.

## Project Structure

```
packages/
  app/          — Web application
  cli/          — CLI entrypoint
  console/      — Terminal UI
  core/         — Core runtime
  desktop/      — Desktop application
  llm/          — LLM provider integrations
  opencode/     — Main agent runtime
  sdk/          — JavaScript SDK
  tui/          — Terminal UI components
  ui/           — Shared UI components
  web/          — Landing page
  ...           — Additional packages
```

## Development

```bash
# Type check all packages
bun typecheck

# Lint
bun run lint

# Format
bun run script/format.ts
```

### Pre-commit

This repo uses Husky with a pre-push hook that runs `bun turbo typecheck`. Ensure all packages typecheck before pushing.

## License

This project is a fork of [OpenCode](https://github.com/anomalyco/opencode) (MIT licensed). Modifications are released under the same [MIT](LICENSE) license.
