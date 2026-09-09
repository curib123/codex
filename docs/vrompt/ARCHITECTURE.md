# Vrompt — Coding Agent

> One coding agent. Multiple AI models.

Vrompt is an independent VS Code coding-agent project built as a downstream fork of the Apache-2.0 licensed OpenAI Codex codebase.

Vrompt is not an official OpenAI product and is not affiliated with or endorsed by OpenAI.

## Goals

- Keep the Codex agent runtime, app-server, filesystem tools, terminal tools, patches, Git integration, sandboxing, approvals, sessions, context handling, plugins, MCP support, and other stable internals wherever practical.
- Make VS Code the primary user experience for Vrompt.
- Add first-class provider and model selection for OpenAI, Anthropic/Claude, Mistral, and Z.ai/GLM.
- Add a simple Auto routing mode that chooses an appropriate model without bypassing Codex security or tool execution layers.
- Minimize invasive edits to upstream Codex so future upstream synchronization remains practical.

## Architecture

```text
Vrompt VS Code Extension
        |
        v
Codex app-server protocol
        |
        v
Vrompt model selection / routing
        |
   +----+----+----------+--------+
   |         |          |        |
OpenAI   Anthropic   Mistral   Z.ai
   |         |          |        |
   +---------+----------+--------+
        |
        v
Existing Codex agent runtime
        |
        v
Approvals / sandbox / tools
        |
   +----+------+-----+-----+
   |           |     |     |
 Files      Terminal Git   MCP
```

## Upstream compatibility

Prefer isolated Vrompt additions under `vrompt/` and small adapter hooks over renaming or moving existing Codex internals.

Keep the fork relationship intact and periodically sync from `openai/codex` before rebasing or merging Vrompt-specific work.

## Provider design

Vrompt should expose a normalized provider registry to the VS Code layer. Provider-specific transport/authentication belongs behind adapters; agent tool execution must remain inside the Codex runtime and its existing approval/sandbox boundaries.

Initial providers:

- OpenAI
- Anthropic / Claude
- Mistral
- Z.ai / GLM

Initial routing modes:

- Auto — Recommended
- Manual provider/model selection

Auto routing should begin simple: classify work as light, standard, or complex and choose the least expensive capable model. Escalate only on repeated failure, unavailable capabilities, or increased task complexity.

## Security rule

Provider responses are model outputs only. They must never directly execute shell commands, filesystem changes, patches, Git operations, or MCP tools outside the existing Codex execution/approval path.
