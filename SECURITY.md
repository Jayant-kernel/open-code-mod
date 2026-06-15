# Security

## Important

This is a personal modification of OpenCode. Security reports for the original project should be directed to the [upstream repository](https://github.com/anomalyco/opencode).

## Threat Model

This mod runs with **unrestricted agent capabilities** — no safety filters, no content policies, and no ethical guidelines. The agent has full access to:

- Shell execution
- File system operations
- Network access
- MCP server integration

### No Sandbox

This mod does **not** sandbox the agent. The permission system exists as a UX feature to help users stay aware of what actions the agent is taking — it prompts for confirmation before executing commands, writing files, etc. However, it is not designed to provide security isolation.

If you need true isolation, run this inside a Docker container or VM.

### Out of Scope

| Category | Rationale |
|---|---|
| **Unrestricted agent behavior** | This is a deliberate feature of the mod |
| **LLM provider data handling** | Data sent to your configured LLM provider is governed by their policies |
| **MCP server behavior** | External MCP servers you configure are outside our trust boundary |
| **Malicious config files** | Users control their own config; modifying it is not an attack vector |

---

**For security issues related to the original OpenCode project**, please report them via the [upstream repository's security advisory](https://github.com/anomalyco/opencode/security/advisories/new).
