# OBLocal Test Plan

## Overview

Single-click test suite to verify the Open Brain local AI memory system is working properly after setup. Tests both the CLI and MCP server components.

## Prerequisites

Run this after `openbrain doctor` passes. Requires:
- Docker services running (`docker compose up -d postgres mcp`)
- Schema migrations applied
- Ollama models pulled (`nomic-embed-text`, `llama3.2-mini`)
- CLI installed (`openbrain` command available)

## Test Phases

### Phase 1: Infrastructure Health

**1.1** Run `openbrain doctor --json`:
```bash
openbrain doctor --json
```

Expected: `{ "passed": true, "checks": [...] }` — exit code 0. All checks pass (config file, Postgres, Ollama, both models available).

---

### Phase 2: Tool Discovery & CLI Basics

**2.1** Run `openbrain --manifest --json`:
```bash
openbrain --manifest --json
```

Expected: `{ "tools": [{ "name": "capture", ... }, { "name": "search", ... }, { "name": "list", ... }, { "name": "stats", ... }] }` — 4 tools listed with input schemas.

**2.2** Initialize (if not already done):
```bash
openbrain init
```

Expected: Creates `~/.openbrain/config.json` with defaults. Exits 0.

---

### Phase 3: CLI — Capture & Embedding

**3.1** Capture a simple observation (always use `--json` for agent use):
```bash
openbrain capture "The sun rises in the east every morning" --json
```

Expected: `{ "id": "uuid", "content": "...", "created_at": "...", "embedded": true }` — exit 0.

**3.2** Capture a second observation (different content):
```bash
openbrain capture "I prefer coffee over tea for morning energy" --json
```

Expected: Different ID from 3.1. Both stored successfully.

**3.3** List thoughts to verify both appear:
```bash
openbrain list --json --limit 10
```

Expected: `{ "thoughts": [...], "count": 2 }` — both captured thoughts in reverse chronological order, no `(pending embedding)` suffix.

**3.4** Verify stats show no pending embeddings:
```bash
openbrain stats --json
```

Expected: `total_thoughts: 2`, `pending_embeddings: 0`.

---

### Phase 4: CLI — Search (Vector Similarity)

**4.1** Search for semantically related content:
```bash
openbrain search "weather and morning" --json --limit 5 --threshold 0.7
```

Expected: Returns the first thought ("The sun rises in the east") with similarity > 0.7. `{ "results": [...], "count": 1 }`.

**4.2** Search for unrelated content:
```bash
openbrain search "machine learning neural networks" --json --limit 5 --threshold 0.7
```

Expected: `{ "results": [], "count": 0 }` — exit 0 (no results is NOT an error).

**4.3** Search with lower threshold to find weak matches:
```bash
openbrain search "software programming code" --json --threshold 0.3 --limit 5
```

Expected: May return results with lower similarity scores.

**4.4** Verify search exits 0 even with no results:
```bash
openbrain search "nonexistent query xyz123" --json; echo "Exit code: $?"
```

Expected: Exit code 0, `results: []`.

---

### Phase 5: CLI — De-duplication

**5.1** Capture the exact same text again:
```bash
openbrain capture "The sun rises in the east every morning" --json
```

Expected: Same ID as 3.1 (deduped by fingerprint). No new entry created.

**5.2** Verify count is still 2:
```bash
openbrain stats --json
```

Expected: `total_thoughts: 2` (unchanged).

---

### Phase 6: CLI — Explicit Backfill

**6.1** The CLI does NOT auto-backfill — agents must trigger explicitly. Test:
```bash
openbrain --backfill --json
```

Expected: `{ "backfilled": 0, "remaining": 0 }` (nothing pending since Ollama has been available).

---

### Phase 7: MCP Server — Tool Calls

For MCP tests, use an MCP-compatible client (Claude Code, Cursor, or any MCP SDK). The MCP server runs via `docker compose exec -i mcp node /app/index.js` (or via `scripts/mcp-wrapper.sh`).

**7.1** Test `search_thoughts`:
```json
{"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "search_thoughts", "arguments": {"query": "morning routine", "limit": 5}}}
```

Expected: Returns relevant thoughts with similarity scores.

**7.2** Test `list_thoughts`:
```json
{"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "list_thoughts", "arguments": {"limit": 10}}}
```

Expected: Lists all thoughts with metadata (topics, type, dates).

**7.3** Test `thought_stats`:
```json
{"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "thought_stats", "arguments": {}}}
```

Expected: Returns total count, embedding stats, top types/topics, recent activity.

**7.4** Test `capture_thought`:
```json
{"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "capture_thought", "arguments": {"content": "Testing MCP capture via JSON-RPC"}}}
```

Expected: `Captured observation — stored with embedding.` — new thought appears in list.

---

### Phase 8: MCP — Metadata Extraction

**8.1** Capture a thought with implied action items:
```json
{"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "capture_thought", "arguments": {"content": "I need to fix the bug in the auth module by Friday and update the tests"}}}
```

Expected: Metadata includes `type: "task"`, `action_items` array with the to-do, `dates_mentioned` with the date.

**8.2** Capture a thought mentioning people:
```json
{"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "capture_thought", "arguments": {"content": "Sarah suggested we use pgvector for the similarity search in the recommendation engine"}}}
```

Expected: Metadata includes `people: ["Sarah"]`, `topics` array.

---

### Phase 9: MCP — Auto-Backfill on Tool Call

**9.1** The MCP server auto-backfills pending embeddings on every tool call (up to 50 rows per call). If Ollama was unavailable at capture time, staged thoughts get embeddings automatically when any tool is invoked. Verify by checking `thought_stats` shows `pending_embeddings: 0` after any tool activity.

---

### Phase 10: Edge Cases

**10.1** Empty search string:
```bash
openbrain search "" --json
```

Expected: Handled gracefully (no crash, returns empty results or error message).

**10.2** List with limit 1:
```bash
openbrain list --json --limit 1
```

Expected: Returns exactly 1 thought.

**10.3** Search with very high threshold (1.0):
```bash
openbrain search "sun rises" --json --threshold 1.0
```

Expected: No results (perfect similarity only matches identical text).

**10.4** Very long thought content — capture and verify it stores correctly:
```bash
openbrain capture "This is a longer thought that contains multiple sentences and tries to test how the system handles longer content with various punctuation and special characters like quotes \" and apostrophes '" and other edge cases" --json
```

Expected: Stores successfully, appears in list.

---

## Success Criteria

All phases pass:
- ✅ Phase 1: `openbrain doctor --json` — all green, exit 0
- ✅ Phase 2: `--manifest --json` returns 4 tools with schemas; `init` works
- ✅ Phase 3: Capture creates embedded thoughts, list shows them without pending suffix
- ✅ Phase 4: Search returns semantically similar results; exit 0 with empty results (not an error)
- ✅ Phase 5: Duplicate content is deduplicated (same ID)
- ✅ Phase 6: `--backfill --json` works and returns `{ "backfilled": N, "remaining": M }`
- ✅ Phase 7: All 4 MCP tools respond correctly
- ✅ Phase 8: Metadata extraction populates type, people, topics, action_items
- ✅ Phase 9: MCP auto-backfills staged embeddings on tool calls
- ✅ Phase 10: Edge cases handled gracefully

## Run All CLI Tests

```bash
# Infrastructure
openbrain doctor --json

# Tool discovery
openbrain --manifest --json

# Capture thoughts
openbrain capture "The sun rises in the east every morning" --json
openbrain capture "I prefer coffee over tea for morning energy" --json

# List and verify
openbrain list --json --limit 10
openbrain stats --json

# Search tests
openbrain search "weather and morning" --json --limit 5 --threshold 0.7
openbrain search "machine learning neural networks" --json --limit 5 --threshold 0.7
openbrain search "machine learning" --json --threshold 0.3 --limit 5

# De-dup test
openbrain capture "The sun rises in the east every morning" --json
openbrain stats --json

# Explicit backfill (CLI only — MCP auto-backfills)
openbrain --backfill --json

# Edge cases
openbrain search "" --json
openbrain list --json --limit 1
openbrain search "sun rises" --json --threshold 1.0
```

For MCP tests, use an MCP-compatible client (Claude Code, Cursor, or any MCP SDK consumer).