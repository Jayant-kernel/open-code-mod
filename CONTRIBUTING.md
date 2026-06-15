# Contributing to open-code-mod

This is a personal modification of OpenCode. Contributions, suggestions, and forks are welcome.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/your-username/open-code-mod.git`
3. Install dependencies: `bun install`
4. Create a branch: `git checkout -b your-feature`

## Development

```bash
# Type check all packages
bun typecheck

# Lint
bun run lint

# Run the dev server (terminal UI)
bun run dev
```

## Pull Requests

- Use conventional commit-style messages: `type(scope): summary`
- Valid types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`
- Ensure all packages pass typecheck before submitting

## Notes

- This mod removes safety filters and content policies by design
- If you're looking for the original project with standard safety features, see [anomalyco/opencode](https://github.com/anomalyco/opencode)
