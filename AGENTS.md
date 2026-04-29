# Open Brain — Local AI Memory

Local-first AI memory: PostgreSQL + pgvector in Docker. Two interfaces — **CLI** (primary) and **MCP server** (alternative). Same 4 capabilities on both.

## Capabilities

| CLI command | MCP tool | What |
|---|---|---|
| `openbrain capture "..."` | `capture_thought` | Store thought + embedding + metadata |
| `openbrain search "..."` | `search_thoughts` | Semantic search |
| `openbrain list --limit 10` | `list_thoughts` | Recent thoughts |
| `openbrain stats` | `thought_stats` | Brain overview |

## CLI Setup

```bash
cd cli && npm install -g .
chmod +x scripts/cli-wrapper.sh
openbrain doctor --json
```

## Usage — How Coding Agents Use It

### Session Start

```bash
openbrain list --json --limit 5        # recall recent context
openbrain stats --json                  # what's in the brain
```

### Capture Decisions, Constraints, Preferences

```bash
openbrain capture "User prefers dark mode. Storing in localStorage." --json
openbrain capture "Backend only supports PostgreSQL 14+. No newer JSONB." --json
openbrain capture "Fix auth bug by Friday — sessions not invalidating" --json
# → metadata.type: "task", dates_mentioned: ["Friday"]

openbrain capture "Sarah is QA contact for this project" --json
# → metadata.people: ["Sarah"]
```

### Search Before Starting New Work

```bash
openbrain search "authentication session logout" --json --limit 5 --threshold 0.7
openbrain search "user theme preferences" --json --limit 3
```

### Pattern Summary

| When | Use | Command |
|---|---|---|
| Session start | Recall context | `openbrain list --json --limit 5` |
| Decision made | Store it | `openbrain capture "Decision: ..."` |
| Constraint found | Store it | `openbrain capture "Constraint: ..."` |
| Task assigned | Store it | `openbrain capture "Need to: ..."` |
| User said X | Store it | `openbrain capture "User said: ..."` |
| Starting new work | Find context | `openbrain search "keywords"` |

Brain persists automatically. No action needed at end of session.

## CLI Invocation

```bash
openbrain <command> --json [args]      # direct
./scripts/cli-wrapper.sh <command> --json [args]  # via wrapper
```

**Exit codes:** `0` = success (including empty search results), `1` = failure.

**If Ollama was down at capture:** call `openbrain --backfill --json` to process pending embeddings.

## CLI Output Schemas

```json
// capture
{ "id": "uuid", "content": "text", "created_at": "ISO8601", "embedded": true, "metadata": { "type": "observation", "topics": ["general"], "people": [], "action_items": [], "dates_mentioned": [] } }

// search
{ "results": [{ "id": "uuid", "content": "text", "metadata": {...}, "similarity": 0.82, "created_at": "..." }], "count": N }

// list
{ "thoughts": [{ "id": "uuid", "content": "text", "metadata": {...}, "created_at": "...", "needs_embedding": false }], "count": N }

// stats
{ "total_thoughts": N, "pending_embeddings": N, "top_types": [...], "top_topics": [...] }
```

## MCP Interface

```bash
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

4 tools: `capture_thought`, `search_thoughts`, `list_thoughts`, `thought_stats`. MCP auto-backfills on every call.

## Config

`~/.openbrain/config.json`:
```json
{
  "database_url": "postgresql://postgres:openbrain@localhost:5432/openbrain",
  "ollama_url": "http://localhost:11434",
  "embedding_model": "nomic-embed-text",
  "chat_model": "llama3.2-mini:Q2_K"
}
```

**Ollama models:** `nomic-embed-text` (embeddings) + `llama3.2-mini:Q2_K` (metadata). Both required.

**Quantization upgrade:** `ollama pull llama3.2-mini:Q4_K_M` → update `chat_model` in config. `safeExtractMetadata` validates all variants.
