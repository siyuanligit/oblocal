# AGENTS.md — Open Brain Local

## What This Is

A local-first AI memory system: PostgreSQL + pgvector in Docker, with two interfaces — **CLI** and **MCP server**. Both expose the same 4 capabilities (capture, search, list, stats). No external APIs. Ollama runs locally.

**CLI is the primary interface.** Use it directly in the terminal. Agents can also invoke it as a subprocess — same interface, no protocol overhead. The MCP server is an alternative for agents that prefer stdio transport.

## Interfaces

Open Brain exposes the same capabilities through two interfaces. Choose based on your tooling.

> **Eureka:** The real distinction between CLI and MCP is not transport — it is **discoverability + statefulness**. MCP supports push notifications (`list_changed`), elicitation (server asks agent for input), and session state. CLI is purely request-response with no server-initiated communication. Choose MCP for conversational agent workflows; choose CLI for one-shot operations and agents that manage their own state.

### CLI — primary interface

`openbrain <command>` on the terminal. Also usable by agents as a subprocess.

- **Human operators**: run directly in terminal
- **Agents**: invoke as a subprocess, parse `--json` output
- Both: same commands, same capabilities

### MCP server — alternative interface

`scripts/mcp-wrapper.sh` — stdio transport for coding agents.

- **Agents that speak MCP natively**: Claude Code, Cursor, Windsurf, etc.
- Configure once via `~/.claude/mcp.json`, agents connect automatically

## Capabilities

Both interfaces expose the same core capabilities:

| Capability | CLI command | MCP tool |
|---|---|---|
| Store a thought | `openbrain capture "..."` | `capture_thought` |
| Search memories | `openbrain search "..."` | `search_thoughts` |
| List recent | `openbrain list --limit 10` | `list_thoughts` |
| View stats | `openbrain stats` | `thought_stats` |
| Discover tools | `openbrain --manifest --json` | (MCP tools/list via protocol) |
| Backfill embeddings | `openbrain --backfill --json` | (auto on every call) |

---

## CLI Interface

### Setup

```bash
# Install CLI (Node 18+)
cd cli && npm install -g .

# Make wrapper executable
chmod +x scripts/cli-wrapper.sh

# Verify connectivity
openbrain doctor --json
```

### Session initialization

At the start of every session, agents should verify the CLI is available and healthy:

```bash
# Verify CLI is in PATH and services are reachable
openbrain doctor --json
# → { "passed": true, "checks": [...] }
# → exit 0 if all green, exit 1 if any check failed
```

### Tool discovery

Before invoking specific commands, agents can call the manifest to get machine-readable tool descriptions:

```bash
openbrain --manifest --json
# → { "tools": [{ "name": "capture", "description": "...", "inputSchema": {...} }, ...] }
```

### Invocation

Agents invoke `openbrain` as a subprocess. Always use `--json` flag. Parse stdout as JSON. Check exit codes.

```bash
# Basic pattern
openbrain <command> --json [args]

# Via wrapper (resolves PATH automatically)
./scripts/cli-wrapper.sh <command> --json [args]
```

### Input escaping

When passing user-supplied text, escape for the shell:

```bash
# Bash: use single quotes or escape inner quotes
openbrain capture 'User'"'"'s thought with "quotes"' --json

# PowerShell: escape inner quotes with backtick
openbrain capture "User`'s thought with `"quotes`"" --json
```

### `--json` output schemas

**`openbrain --manifest --json`**
```json
{ "tools": [{ "name": "capture", "description": "Store a thought with Ollama embedding", "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] } }, ...] }
```

**`openbrain capture "text" --json`**
```json
{ "id": "uuid", "content": "text", "created_at": "ISO8601", "embedded": true }
```

**`openbrain search "query" --json [--limit N] [--threshold X]`**
```json
{ "results": [{ "id": "uuid", "content": "text", "metadata": {}, "similarity": 0.82, "created_at": "ISO8601" }], "count": N }
```

**`openbrain list --json [--limit N]`**
```json
{ "thoughts": [{ "id": "uuid", "content": "text", "metadata": {}, "created_at": "ISO8601", "needs_embedding": false }], "count": N }
```

**`openbrain stats --json`**
```json
{ "total_thoughts": N, "pending_embeddings": N, "top_types": [{ "type": "observation", "count": 10 }], "top_topics": [...] }
```

**`openbrain --backfill --json`**
```json
{ "backfilled": 3, "remaining": 0 }
```

**`openbrain doctor --json`**
```json
{ "passed": true, "checks": [{ "name": "postgres", "passed": true, "message": "..." }] }
```

### Exit codes

- `0` — success (including "no results found" for search)
- `1` — failure (connection error, invalid input, service unavailable)

### Embedding Failure / Staging

If Ollama was unavailable at capture time, thoughts are stored with `needs_embedding = true`. Agents should call `openbrain --backfill --json` to process pending embeddings:

```bash
openbrain --backfill --json
# → { "backfilled": N, "remaining": M }
```

The MCP server handles backfill automatically on every tool call. CLI agents must trigger it explicitly.

### Source tracking

When an agent captures via CLI, the `source` column defaults to `"local"`. To identify which agent captured a thought, agents can set the `source` field in metadata (future enhancement: `--source` flag).

---

## MCP Interface

### Setup

```bash
# Make wrapper executable
chmod +x scripts/mcp-wrapper.sh
```

In `~/.claude/mcp.json`:
```json
{
  "mcpServers": {
    "openbrain": {
      "command": "/path/to/OBLocal/scripts/mcp-wrapper.sh"
    }
  }
}
```

The wrapper uses `docker compose exec mcp` (service name, not container name) — works regardless of container naming.

### Tools

When connected via MCP, agents get 4 tools: `capture_thought`, `search_thoughts`, `list_thoughts`, `thought_stats`.

### Backfill behavior

The MCP server runs `backfillPendingEmbeddings()` opportunistically on **every** tool call, processing up to 50 pending embeddings before handling the actual request. No explicit backfill command needed.

### Multiple agents sharing one brain

All agents connect to the same Docker container via stdio wrapper. The `source` column in `thoughts` tracks which agent captured each entry.

---

## Architecture

- **postgres** container: pgvector/pgvector:pg16 on port 5432
- **mcp** container: Node.js MCP server, always-on, connects to Ollama at `host.docker.internal:11434`
- **CLI** runs on host (not in Docker) — reads `~/.openbrain/config.json`
- **MCP agents** spawn fresh Node.js process per invocation via `docker compose exec`

## Config

`~/.openbrain/config.json`:
```json
{
  "database_url": "postgresql://postgres:openbrain@localhost:5432/openbrain",
  "ollama_url": "http://localhost:11434",
  "embedding_model": "nomic-embed-text",
  "chat_model": "llama3.2-mini"
}
```

## Ollama Models

- `nomic-embed-text` — 1536-dim embedding vectors
- `llama3.2-mini` — metadata extraction (JSON mode)

Both must be pulled: `ollama pull nomic-embed-text && ollama pull llama3.2-mini`

## Monorepo Structure

```
cli/          — openbrain CLI (Node 18+, host machine)
server/       — MCP server (Node.js in Docker)
schema/       — SQL migrations (run manually)
setup/        — Setup scripts (run in sequence)
scripts/
  mcp-wrapper.sh   — MCP interface wrapper
  cli-wrapper.sh    — CLI interface wrapper
```

## No Test Suite

This repo has no automated tests. Setup is verified manually via `openbrain doctor` and `openbrain capture`.