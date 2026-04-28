# OBLocal Test Suite

## Running Tests

```bash
cd tests
npm install
npm test
```

## Prerequisites

- Docker services running (`docker compose up -d postgres mcp`)
- Schema migrations applied
- Ollama models pulled
- CLI installed (`openbrain` command available)

## Test Phases

| Phase | Test | Description |
|-------|------|-------------|
| 1 | Infrastructure | `openbrain doctor --json` |
| 2 | Tool Discovery | `--manifest --json`, `init` |
| 3 | Capture & Embedding | Capture, list, stats |
| 4 | Search | Vector similarity search |
| 5 | De-duplication | Same content returns same ID |
| 6 | Backfill | `--backfill --json` |
| 10 | Edge Cases | Empty search, limit, long content |

## MCP Tests

Phases 7-9 require an MCP-compatible client (Claude Code, Cursor, etc.) and are not automated in this suite.