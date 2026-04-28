# Open Brain — local-version Development Plan

## What We're Building

A fully local Open Brain: your own PostgreSQL + pgvector database, with two interfaces — **CLI** and **MCP server**. Both expose the same 4 capabilities (capture, search, list, stats). No external APIs, no cloud services.

**CLI is the primary interface.** Humans use it directly in the terminal. Coding agents can also invoke it as a subprocess and parse `--json` output — this is the same interface, not a separate mechanism. The MCP server is an alternative for agents that prefer stdio transport.

- **CLI** — runs on host machine. Human operators use it directly. Agents invoke it as a subprocess, parse `--json` output. Same 4 capabilities.
- **MCP server** — runs in Docker, connects to coding agents via stdio transport. Alternative interface for stdio-native agents.

---

## Design Decisions (Confirmed)

| Decision | Choice |
|---|---|
| **Database** | PostgreSQL + pgvector in Docker. Native install instructions also provided. |
| **Embedding** | Ollama `nomic-embed-text` (1536-dim) — runs locally, no external API calls |
| **Metadata extraction** | Ollama `llama3.2-mini` (JSON mode) — configurable via `config.json` |
| **CLI** | Primary interface — standalone, fully independent. Humans use it directly; agents invoke it as a subprocess. Same 4 capabilities as MCP. |
| **MCP server** | Alternative interface — always-on Docker container, stdio transport for agents that prefer MCP protocol. Same 4 capabilities as CLI. |
| **Auth** | None — localhost-only, no external exposure |
| **Config** | `~/.openbrain/config.json` — database_url, ollama_url, embedding_model, chat_model |
| **Windows support** | Docker first-class — consistent across all platforms |
| **Data migration** | None — fresh local brain |

---

## Folder Structure

```
local-version/
├── docker-compose.yml          # postgres + pgvector + mcp (always-on)
├── Dockerfile.mcp               # Node.js MCP server image
├── scripts/
│   ├── mcp-wrapper.sh           # docker compose exec -i mcp (service name) — MCP agents
│   └── cli-wrapper.sh           # openbrain <cmd> --json — agents invoke CLI as subprocess
├── schema/
│   ├── 001-thoughts.sql         # thoughts table + indexes + trigger
│   ├── 002-match-thoughts.sql   # match_thoughts RPC
│   ├── 003-upsert-thought.sql   # upsert_thought RPC (fingerprint dedup)
│   └── 004-backfill-embeddings.sql  # backfill_pending_embeddings RPC (no-op, Node.js does actual work)
├── server/
│   ├── package.json
│   └── index.js                 # MCP server: 4 tools, stdio transport
├── cli/
│   ├── package.json
│   └── src/
│       └── index.js             # CLI: capture, search, list, stats (independent)
├── setup/
│   ├── 01-start-docker.sh       # docker compose up (no migrations)
│   ├── 02-run-migrations.sh    # user-initiated SQL migrations
│   ├── 03-setup-ollama.sh       # install Ollama + pull nomic-embed-text + llama3.2-mini
│   ├── 04-setup-cli.sh          # npm install -g openbrain-cli
│   └── 05-connect-agents.sh    # CLI + MCP integration guide (both interfaces)
├── README.md
└── dev-plan.md
```

---

## Phase 1: PostgreSQL + pgvector (Docker) — DEPENDS ON: nothing (start here)

### 1.1 `docker-compose.yml`

Single compose file starts two services:
- **postgres**: `pgvector/pgvector:pg16` on port `5432`, volume `./data/postgres`, env vars `POSTGRES_DB=openbrain`, `POSTGRES_USER=postgres`, `POSTGRES_PASSWORD=openbrain`, health check via `pg_isready`
- **mcp**: built from `Dockerfile.mcp`, always-on (`restart: unless-stopped`), connected to postgres via `DATABASE_URL` env var, Ollama at `host.docker.internal:11434` via `extra_hosts: host.docker.internal:host-gateway`

### 1.2 Native install fallback

`setup/01-postgres-native.sh` for users who prefer native PostgreSQL:
- macOS: `brew install postgresql@16 && brew install pgvector`
- Linux: `apt-get install postgresql-16 postgresql-16-pgvector`
- Windows: Docker strongly recommended, but native instructions provided

### 1.3 Schema migrations (run via `docker compose exec`)

**`schema/001-thoughts.sql`**:
```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE thoughts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  metadata JSONB DEFAULT '{}'::jsonb,
  content_fingerprint TEXT,
  source TEXT DEFAULT 'local',
  needs_embedding BOOLEAN DEFAULT false,  -- true when Ollama was unavailable at capture time
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON thoughts USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON thoughts USING gin (metadata);
CREATE INDEX ON thoughts (created_at DESC);
CREATE INDEX ON thoughts (needs_embedding) WHERE needs_embedding = true;  -- fast lookup of staged thoughts

CREATE UNIQUE INDEX idx_thoughts_fingerprint ON thoughts (content_fingerprint) WHERE content_fingerprint IS NOT NULL;

CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER thoughts_updated_at BEFORE UPDATE ON thoughts FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

**`schema/002-match-thoughts.sql`**:
```sql
CREATE OR REPLACE FUNCTION match_thoughts(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  filter JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (id UUID, content TEXT, metadata JSONB, similarity FLOAT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT t.id, t.content, t.metadata,
    (1 - (t.embedding <=> query_embedding))::FLOAT AS similarity,
    t.created_at
  FROM thoughts t
  WHERE 1 - (t.embedding <=> query_embedding) > match_threshold
    AND (filter = '{}'::jsonb OR t.metadata @> filter)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

**`schema/003-upsert-thought.sql`**:
```sql
CREATE OR REPLACE FUNCTION upsert_thought(p_content TEXT, p_payload JSONB DEFAULT '{}')
RETURNS JSONB AS $$
DECLARE
  v_fingerprint TEXT;
  v_id UUID;
BEGIN
  v_fingerprint := encode(sha256(convert_to(
    lower(trim(regexp_replace(p_content, '\s+', ' ', 'g'))), 'UTF8'
  )), 'hex');

  INSERT INTO thoughts (content, content_fingerprint, metadata)
  VALUES (p_content, v_fingerprint, p_payload)
  ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
  SET updated_at = now(),
      metadata = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'fingerprint', v_fingerprint);
END;
$$ LANGUAGE plpgsql;
```

**`schema/004-backfill-embeddings.sql`**:
```sql
-- Helper view to quickly see which thoughts are pending embedding (Ollama was unavailable at capture time).
-- The MCP server's Node.js `backfillPendingEmbeddings()` function processes these:
--   1. SELECT * FROM thoughts WHERE needs_embedding = true AND embedding IS NULL
--   2. For each row: call Ollama /api/embeddings, UPDATE thoughts SET embedding = <result>, needs_embedding = false
--   3. Continue until no pending rows remain

CREATE OR REPLACE FUNCTION backfill_pending_embeddings()
RETURNS JSONB AS $$
DECLARE
  v_pending RECORD;
  v_embedding VECTOR(1536);
  v_count INT := 0;
  v_failed INT := 0;
BEGIN
  -- Note: The Ollama HTTP call must happen in Node.js (outside SQL).
  -- This function is a no-op placeholder — the actual backfill logic lives in server/index.js.
  -- The MCP server's backfillPendingEmbeddings() is called on every tool invocation opportunistically.
  -- This SQL function is kept for completeness so migrations can reference it.

  RETURN jsonb_build_object('note', 'backfill happens in Node.js, not SQL');
END;
$$ LANGUAGE plpgsql;
```

**Backfill implementation (Node.js, not SQL):**

The MCP server's `backfillPendingEmbeddings()` function:
```javascript
async function backfillPendingEmbeddings(pgPool, ollamaUrl) {
  const result = await pgPool.query(
    'SELECT id, content FROM thoughts WHERE needs_embedding = true AND embedding IS NULL ORDER BY created_at ASC LIMIT 50'
  );
  for (const row of result.rows) {
    try {
      const embedding = await getEmbedding(row.content, ollamaUrl);
      await pgPool.query(
        'UPDATE thoughts SET embedding = $1, needs_embedding = false WHERE id = $2',
        [embedding, row.id]
      );
    } catch {
      // Leave needs_embedding = true, will retry on next tool call
    }
  }
}
```

**Called on every tool invocation** — before processing the actual request, the server opportunistically processes up to 50 pending embeddings. This way, any agent activity will gradually clear the backlog without a dedicated background job.

---

## Phase 2: MCP Server (Node.js) — DEPENDS ON: Phase 1

### 2.1 `server/package.json`

```json
{
  "name": "openbrain-mcp",
  "version": "1.0.0",
  "type": "module",
  "main": "index.js",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "pg": "^8.13.0",
    "dotenv": "^16.4.0"
  },
  "scripts": {
    "start": "node index.js"
  }
}
```

### 2.2 `server/index.js` — Stdio MCP Server

Key implementation details:
- Use `@modelcontextprotocol/sdk` `McpServer` class
- `StdioTransport` for stdio communication
- Reads DB URL and Ollama URL from `~/.openbrain/config.json`
- Auth: **none** (localhost stdio, no external exposure)

**Architecture note:** The MCP container runs as a long-lived daemon (always-on). Each connecting agent spawns a fresh Node.js process via `docker compose exec -i mcp` — this is how stdio transport works with `@modelcontextprotocol/sdk`. Connection pooling is per-process (fine since agents don't share pools). Ollama HTTP calls are stateless and independent per tool invocation.

**Four tools** (same as Supabase version, but local embedding):

1. **`search_thoughts`** — calls Ollama for query embedding (`POST http://localhost:11434/api/embeddings` with `nomic-embed-text`), then calls `match_thoughts` RPC via `pg.Client.query('SELECT * FROM match_thoughts(...)')`. Tool input schema: `query: string`, `limit: number (default 10)`, `threshold: number (default 0.7)`. Results formatted same as Supabase version. **If no results found:** returns "No thoughts found matching '[query]'." and additionally checks `SELECT count(*) FROM thoughts WHERE needs_embedding = true` — if any staged thoughts exist, appends: "Note: [N] thought(s) are pending embedding (Ollama was unavailable at capture time)."

2. **`list_thoughts`** — `SELECT content, metadata, created_at FROM thoughts ORDER BY created_at DESC` with optional filters (type, topic, person, days). Staged thoughts (`needs_embedding = true`) show a `(pending embedding)` note in output.

3. **`thought_stats`** — aggregate counts, top types, top topics from metadata JSONB

4. **`capture_thought`** — generates embedding via Ollama, stores content + embedding + metadata via `upsert_thought` RPC. Metadata extraction uses Ollama (`llama3.2-mini` with JSON mode, configurable via `config.json`).

**Capture flow (Option C — staging logic isolated to Node.js):**
1. Call `upsert_thought(p_content, p_payload)` RPC → returns `{ id, fingerprint }`
2. Attempt to get embedding from Ollama via `getEmbedding(content, ollamaUrl)`
3. If embedding succeeds → `UPDATE thoughts SET embedding = $1, needs_embedding = false WHERE id = $id`
4. If embedding fails (Ollama unavailable) → `UPDATE thoughts SET needs_embedding = true WHERE id = $id AND embedding IS NULL`

**Ollama failure resilience:**
- If Ollama embedding call fails (connection refused, model not found, timeout): after `upsert_thought` returns, the server sets `needs_embedding = true` and returns: "Captured [type] — embedding staged for later (Ollama unavailable)."
- If metadata extraction fails: use fallback `{ topics: ["uncategorized"], type: "observation" }` — metadata extraction is best-effort, never blocks capture.
- **Opportunistic backfill:** On every tool call, before doing actual work, the server calls `backfillPendingEmbeddings()` which processes up to 50 pending rows (SELECT → Ollama → UPDATE). Any agent activity gradually clears the backlog — no dedicated background job needed.

### 2.3 Ollama embedding call

```javascript
async function getEmbedding(text) {
  const response = await fetch("http://localhost:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "nomic-embed-text",
      prompt: text
    })
  });
  const data = await response.json();
  return data.embedding; // 1536-dim array
}
```

### 2.4 Metadata extraction via Ollama

```javascript
async function extractMetadata(text) {
  const response = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama3.2-mini",  // configurable in config.json, upgrade to llama3.2 for better quality
      stream: false,
      format: "json",
      messages: [{
        role: "system",
        content: `Extract metadata from the user's thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`
      }, { role: "user", content: text }]
    })
  });
  const data = await response.json();
  return JSON.parse(data.message.content);
}
```

Fallback if Ollama not available: return `{ topics: ["uncategorized"], type: "observation" }`.

### 2.5 Dockerfile for MCP server

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY server/package.json .
RUN npm install
COPY server/ .
CMD ["node", "index.js"]
```

---

## Phase 3: CLI Tool + CLI Interface for Agents — DEPENDS ON: Phase 1 (independent of Phase 2)

### 3.1 `cli/package.json`

```json
{
  "name": "openbrain-cli",
  "version": "1.0.0",
  "type": "module",
  "bin": { "openbrain": "./src/index.js" },
  "dependencies": {
    "pg": "^8.13.0",
    "dotenv": "^16.4.0",
    "commander": "^12.1.0"
  }
}
```

### 3.2 Commands

| Command | Description | Exit Codes |
|---|---|---|
| `openbrain capture "text"` | Store thought with Ollama embedding | 0 success, 1 capture failed |
| `openbrain search "query"` | Generate embedding via Ollama, run `match_thoughts` RPC directly | 0 success (even if no results), 1 search failed |
| `openbrain list --limit 10` | List recent thoughts | 0 success, 1 db error |
| `openbrain stats` | Show brain overview | 0 success, 1 db error |
| `openbrain doctor` | Check Postgres, Ollama, config file connectivity | 0 all green, 1 one or more checks failed |
| `openbrain init` | Create ~/.openbrain/config.json | 0 success, 1 already exists or write error |

All commands support `--json` flag for machine-readable output (scripting/agent use). Default output is plain text for human readability.

The same commands work for both human operators and agents. Two additional commands are primarily useful for agents:

| Command | Description | Exit Codes |
|---|---|---|
| `openbrain --manifest --json` | Output machine-readable tool descriptions (for agent discovery) | 0 always |
| `openbrain --backfill --json` | Process up to 50 pending embeddings, return backfill report | 0 always |

### 3.3 CLI architecture

- Reads `~/.openbrain/config.json` for all configuration
- **Fully independent** — CLI works standalone without MCP server
- Same 4 capabilities as MCP server: `capture`, `search`, `list`, `stats`
- Both `capture` and `search` use the same `getEmbedding(ollamaUrl, text)` helper
- CLI and MCP share the same Ollama call patterns — equivalent functionality

**Output:** Plain text by default. All commands support `--json` flag.
**Exit codes:** Standard Unix — `0` success, `1` failure.

**Config file (`~/.openbrain/config.json`):**
```json
{
  "database_url": "postgresql://postgres:openbrain@localhost:5432/openbrain",
  "ollama_url": "http://localhost:11434",
  "embedding_model": "nomic-embed-text",
  "chat_model": "llama3.2-mini"
}
```

**`openbrain init`:**
- Writes config with defaults (no Docker check — runs before containers start)
- Prompts user to confirm or override Ollama URL and model choices
- If `~/.openbrain/config.json` already exists, prompts to overwrite
- User can re-run `init` to override, or edit the file directly

**`openbrain doctor`:**
1. Postgres reachable via `pg_isready`
2. Ollama reachable via `GET /api/tags`
3. Config file exists and is valid JSON
4. Both models (`nomic-embed-text`, `llama3.2-mini`) are pulled
5. **Fails fast** — exits non-zero on first failure, prints actionable message. Does not auto-fix.

### 3.4 `scripts/cli-wrapper.sh` — CLI wrapper for agents

Agents invoke `openbrain` as a subprocess. This wrapper resolves the `openbrain` binary from PATH (set by `npm install -g`) and handles cross-platform execution.

```bash
#!/bin/bash
# Resolves openbrain from PATH set by npm install -g
# Agents call: cli-wrapper.sh <command> --json [args]

# Note: do NOT use `set -e` — openbrain search returns exit 1 when no results
# are found, which is correct behavior, not an error.

if ! command -v openbrain &> /dev/null; then
  echo 'Error: openbrain not found in PATH. Run: npm install -g ./cli' >&2
  exit 1
fi

exec openbrain "$@"
```

**Windows PowerShell fallback** (for agents running in PowerShell without WSL):
```powershell
# cli-wrapper.ps1
$openbrain = Get-Command openbrain -ErrorAction SilentlyContinue
if (-not $openbrain) {
    Write-Error "openbrain not found in PATH. Run: npm install -g .\cli"
    exit 1
}
& $openbrain $args
exit $LASTEXITCODE
```

**Key design decisions:**
- Wrapper is a thin shim — all logic lives in the CLI itself
- No Docker involvement — agents run the CLI directly on the host
- `chmod +x` required after clone: `chmod +x scripts/cli-wrapper.sh`

### 3.5 CLI Interface for Agents — subprocess invocation pattern

Coding agents that do not use MCP can invoke `openbrain` as a subprocess and parse `--json` output. This is a parallel path to MCP — agents choose based on their tooling.

**When to use CLI vs MCP:**

> **EUREKA:** The real distinction between CLI and MCP is not transport (subprocess vs stdio) — it is **discoverability + statefulness**. MCP servers can push `list_changed` notifications, support elicitation (server asks agent for clarification), and maintain session state. CLI is purely request-response with no server-initiated communication.

- **CLI**: agents that manage their own subprocess lifecycle, prefer parsing structured JSON output, need one-shot operations, or manage their own state
- **MCP**: stdio-native agents that need dynamic tool discovery, push notifications, or multi-step conversational interactions with the server initiating contact

**Session initialization pattern:**
Agents should call `openbrain doctor --json` at the start of every session to (a) verify connectivity and (b) confirm the CLI is available in PATH:

```bash
openbrain doctor --json
# → { "passed": true, "checks": [...] }
# → exit 0 if all green, exit 1 if any check failed
```

**Tool discovery:** Before invoking specific commands, agents can call `openbrain --manifest --json` to get a machine-readable description of all available tools:

```bash
openbrain --manifest --json
# → { "tools": [{ "name": "capture", "description": "...", "inputSchema": {...} }, ...] }
```

**How agents invoke CLI:**
```bash
# Capture
openbrain capture "thought text" --json
# → stdout: { "id": "uuid", "content": "thought text", "created_at": "...", "embedded": true }
# → exit 0

# Search
openbrain search "query" --json --limit 5 --threshold 0.75
# → stdout: { "results": [{ "id": "...", "content": "...", "similarity": 0.82, ... }], "count": 2 }
# → exit 0 (even if count is 0, count=0 is not an error)

# List
openbrain list --json --limit 10
# → stdout: { "thoughts": [{ "id": "...", "content": "...", "created_at": "...", "needs_embedding": false }], "count": 5 }

# Stats
openbrain stats --json
# → stdout: { "total_thoughts": 42, "pending_embeddings": 0, "top_types": [...], "top_topics": [...] }

# Backfill (process pending embeddings)
openbrain --backfill --json
# → stdout: { "backfilled": 3, "remaining": 0 }
# → exit 0 always (non-destructive)

# Doctor (agent verification)
openbrain doctor --json
# → stdout: { "passed": true, "checks": [{ "name": "postgres", "passed": true, "message": "..." }] }
# → exit 0 if all pass, exit 1 if any fail
```

**Agent integration example (pseudocode):**
```javascript
// 1. Session init — verify CLI is available
const doctor = JSON.parse(await run('openbrain', ['doctor', '--json']));
if (!doctor.passed) {
  throw new Error('OpenBrain not available: ' + doctor.checks.filter(c => !c.passed).map(c => c.message).join(', '));
}

// 2. Optional: discover available tools
const manifest = JSON.parse(await run('openbrain', ['--manifest', '--json']));

// 3. Capture a thought
const capture = JSON.parse(await run('openbrain', ['capture', 'Remember to refactor the auth module', '--json']));

// 4. Search
const search = JSON.parse(await run('openbrain', ['search', 'authentication', '--json', '--limit', '5']));
for (const thought of search.results) {
  console.log(`[${(thought.similarity * 100).toFixed(1)}%] ${thought.content}`);
}

// 5. Backfill if needed (process any pending embeddings from offline captures)
const backfill = JSON.parse(await run('openbrain', ['--backfill', '--json']));
```

**Input escaping:** When passing user-supplied text as arguments, agents must escape or quote properly for the shell:
```bash
# Bash: use single quotes or escape double quotes inside the text
openbrain capture 'User'"'"'s thought with "quotes"' --json
# PowerShell: escape inner quotes with backtick
openbrain capture "User`'s thought with `"quotes`"" --json
```

**Requirements for agents:**
1. `openbrain` must be in PATH (run `npm install -g ./cli` first)
2. Always use `--json` flag — agents parse stdout as JSON, never rely on text format
3. Check exit codes — `0` = success, `1` = failure (but "no results found" is exit 1 with valid empty `results: []`)
4. Call `openbrain doctor --json` at session start to verify connectivity
5. Call `openbrain --backfill --json` to process any embeddings that staged while Ollama was unavailable

**MCP backfill parity:** The MCP server runs `backfillPendingEmbeddings()` opportunistically on every tool call. The CLI does not auto-backfill — agents must explicitly call `openbrain --backfill --json` to process pending embeddings. This ensures agents control when backfill happens rather than having it trigger unexpectedly mid-session.

### 3.6 `AGENTS.md` redesign — unified two-interface overview

Replace the existing AGENTS.md content with a structure that opens with both interfaces as equal options, CLI prioritized. The MCP section becomes "MCP Interface" alongside "CLI Interface" — not a separate "MCP Agent Integration" silo.

**New `AGENTS.md` structure:**

```markdown
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
  cli-wrapper.sh   — CLI interface wrapper
```

## No Test Suite

This repo has no automated tests. Setup is verified manually via `openbrain doctor` and `openbrain capture`.
```

---

## Phase 4: MCP Interface (Alternative) — DEPENDS ON: Phase 2

Phase 3 covers the CLI interface (primary). This phase covers the MCP interface (alternative) — the wrapper script that lets stdio-native agents connect.

MCP interface details (setup, tools, multi-agent behavior) are documented in the `AGENTS.md` redesign in Phase 3.6. Only the wrapper implementation lives here.

### 4.1 `scripts/mcp-wrapper.sh`

```bash
#!/bin/bash
# Uses docker compose exec (service name, not container name) — no hardcoded container name
docker compose exec -i mcp node /app/index.js
```

This wrapper pipes stdin/stdout from the Docker container to the calling agent. Claude Code, Cursor, and other stdio-based agents use this to communicate with the containerized MCP server.

---

## Phase 5: Setup Automation — DEPENDS ON: Phase 1

**Setup order (user runs manually, in sequence):**
```
1. openbrain init                   → creates ~/.openbrain/config.json (before starting docker)
2. 01-start-docker.sh              → starts postgres + mcp containers (NO migrations)
3. 02-run-migrations.sh            → user-initiated schema migration (Supabase-style)
4. 03-setup-ollama.sh              → install Ollama + pull models
5. 04-setup-cli.sh                → npm install -g the CLI (if not installed in step 1)
6. 05-connect-agents.sh           → both interfaces guide (CLI + MCP)
```

**Design: `openbrain init` runs before Docker, writes config with defaults.**
`openbrain init` does NOT check Docker connectivity — it just writes `~/.openbrain/config.json` with sensible defaults:
```json
{
  "database_url": "postgresql://postgres:openbrain@localhost:5432/openbrain",
  "ollama_url": "http://localhost:11434",
  "embedding_model": "nomic-embed-text",
  "chat_model": "llama3.2-mini"
}
```
User can re-run `init` to override, or edit `~/.openbrain/config.json` directly.

**Design: Docker defaults match config defaults.**
The `docker-compose.yml` uses the same default connection string as `~/.openbrain/config.json`:
```yaml
DATABASE_URL: postgresql://postgres:openbrain@postgres:5432/openbrain
```
If the MCP container starts before `~/.openbrain/config.json` exists, it falls back to `process.env.DATABASE_URL` (set via docker-compose). Both point to the same URL — no conflict.

### 5.1 `setup/01-start-docker.sh`

```bash
docker compose up -d postgres
docker compose up -d mcp
docker compose ps  # verify both containers are healthy
```

**Does NOT run migrations.** Containers start, user confirms health, then runs migration step next.

### 5.2 `setup/02-run-migrations.sh`

**User-initiated** — same pattern as Supabase (user pastes/runs SQL manually). This script provides the equivalent as a runnable script:
```bash
echo "Running schema migrations..."
docker compose exec -T postgres psql -U postgres -d openbrain -f /schema/001-thoughts.sql
docker compose exec -T postgres psql -U postgres -d openbrain -f /schema/002-match-thoughts.sql
docker compose exec -T postgres psql -U postgres -d openbrain -f /schema/003-upsert-thought.sql
echo "Migrations complete. Verify with: docker compose exec postgres psql -U postgres -d openbrain -c '\\dt'"
```

Users who started postgres earlier re-run this to apply migrations.

### 5.3 `setup/03-setup-ollama.sh`

```bash
# Install Ollama (macOS/Linux)
curl -fsSL https://ollama.com/install.sh | sh

# Pull embedding model
ollama pull nomic-embed-text

# Pull chat model for metadata extraction (llama3.2-mini)
ollama pull llama3.2-mini

# Verify
ollama run nomic-embed-text "test"
```

Windows: Download Ollama from ollama.com, then in PowerShell:
```powershell
ollama pull nomic-embed-text
ollama pull llama3.2-mini
```

### 5.4 `setup/04-setup-cli.sh`

```bash
# Check Node.js version (requires >= 18)
node --version | grep -q "^v1[8-9]\|^v[2-9]" || { echo "Node.js 18+ required"; exit 1; }
cd ../cli && npm install -g .
openbrain init  # creates ~/.openbrain/config.json (skipped if already exists)
```

**Requires:** Node.js 18+ on the host machine (CLI runs on host, not in Docker).

### 5.5 `setup/05-connect-agents.sh`

Prints platform-specific instructions for both interfaces — CLI (subprocess) and MCP (stdio). Covers setup for Claude Code, Cursor, Windsurf, and any agent that invokes `openbrain` as a subprocess.

---

## Phase 6: Documentation — DEPENDS ON: Nothing (independent, can start now)

### 6.1 `README.md` — Full setup guide

Follows the same visual pattern as `docs/01-getting-started.md` (step badges, `✅ Done when:` checkpoints, collapsible SQL, numbered commands).

**Structure:**
```
# Build Your Local Open Brain

![Step 1](https://img.shields.io/badge/Step_1-Install_Docker-1E88E5?style=for-the-badge)
![Step 2](https://img.shields.io/badge/Step_2-Start_Containers-43A047?style=for-the-badge)
![Step 3](https://img.shields.io/badge/Step_3-Run_Migrations-8E24AA?style=for-the-badge)
![Step 4](https://img.shields.io/badge/Step_4-Setup_Ollama-FB8C00?style=for-the-badge)
![Step 5](https://img.shields.io/badge/Step_5-Install_CLI-00897B?style=for-the-badge)
![Step 6](https://img.shields.io/badge/Step_6-Verify_Setup-5C6BC0?style=for-the-badge)
![Step 7](https://img.shields.io/badge/Step_7-Connect_Agents-D555555?style=for-the-badge)
![Step 8](https://img.shields.io/badge/Step_8-Use_It-8E24AA?style=for-the-badge)
```

Each step has `✅ **Done when:**` checkpoints and numbered commands.

**Step 1: Install Docker** — Docker Desktop (Windows/macOS) or native (Linux)
**Step 2: Start Containers** — `01-start-docker.sh` → containers running
**Step 3: Run Migrations** — `02-run-migrations.sh` → tables created
**Step 4: Setup Ollama** — `03-setup-ollama.sh` → models pulled
**Step 5: Install CLI** — `04-setup-cli.sh` → `openbrain --version` works
**Step 6: Verify** — `openbrain doctor` → all green, `openbrain capture "test"` → works
**Step 7: Connect Agents** — `05-connect-agents.sh` → Claude Code / Cursor connected
**Step 8: Use It** — natural language prompts, same as Supabase guide

### 6.2 Comparison to Supabase version

| Aspect | Supabase (cloud) | local-version |
|---|---|---|
| **Database** | Hosted PostgreSQL | Local Docker container |
| **Embedding** | OpenRouter API call | Local Ollama (`nomic-embed-text`) |
| **Metadata extraction** | GPT-4o-mini via OpenRouter | Local Ollama (`llama3.2-mini`, configurable) |
| **Auth** | Access key in URL/header | None (localhost stdio) |
| **MCP transport** | StreamableHTTP (cloud Edge Function) | Stdio over Docker |
| **MCP server startup** | `supabase functions deploy` | `docker run` (always-on container) |
| **CLI embedding** | OpenRouter | Ollama (local) |
| **External API calls** | Required (OpenRouter) | None |

---

## Phase Dependency Matrix

**Hard dependency chain:** Phase 1 → Phase 2/3/5 (sequential)
**Independent phases:** Phase 4 (MCP interface), Phase 6 (README) — can be written at any time

```
Phase 1 (Docker + DB)         ← blocks all other phases
    ↓
Phase 2 (MCP server)          ← needs Phase 1
Phase 3 (CLI + CLI interface)   ← needs Phase 1
Phase 5 (Setup scripts)        ← needs Phase 1
    ↓
Phase 4 (MCP interface)         ← needs Phase 2 (mcp-wrapper.sh) — the alternative interface

Phase 6 (README)              ← INDEPENDENT — can start immediately
```

### Parallel Work Possible

| Agent | Can work on | Dependency |
|---|---|---|
| Agent A | Phase 2 (MCP server) | Only Phase 1 |
| Agent B | Phase 3 (CLI + CLI interface for agents) | Only Phase 1 |
| Agent C | Phase 4 (MCP interface — alternative) | Only Phase 2 |
| Agent D | Phase 6 (README) | **Nothing** |

Agents A, B, C can all work **simultaneously** after their respective dependencies are met. Agent D can start immediately.

---

## Implementation Order

```
Phase 1 → docker-compose.yml + Dockerfile.mcp + schema/*.sql (blocks everything)
Phase 2 → server/index.js (MCP server, stdio)         ┐ independent
Phase 3 → cli/src/index.js + cli-wrapper.sh         ┤ after Phase 1
         + AGENTS.md CLI interface section            │
Phase 4 → scripts/mcp-wrapper.sh (MCP interface — alternative)  (after Phase 2)
Phase 5 → setup/*.sh scripts                            (after Phase 1)
Phase 6 → README.md                                    (independent, start now)
```

---

## Verification Checklist

### Phase 1 — Docker + DB (must complete before all others)
- [ ] `docker compose up` starts postgres with pgvector
- [ ] Migrations run without error
- [ ] `SELECT * FROM match_thoughts(...)` RPC works manually

### Phase 2 — MCP Server (independent of Phase 3)
- [ ] `node server/index.js` starts without errors
- [ ] `ollama pull nomic-embed-text` succeeds
- [ ] Ollama embedding call returns 1536-dim array
- [ ] MCP tools respond via stdio

### Phase 3 — CLI + CLI Interface for Agents (independent of Phase 2)
- [ ] `npm install -g` the CLI
- [ ] `openbrain capture "test"` stores thought with Ollama embedding
- [ ] `openbrain list` returns stored thoughts
- [ ] `openbrain doctor` reports all green
- [ ] `openbrain search "test" --json` returns valid JSON with `results` or empty array
- [ ] `openbrain capture "test" --json` returns valid JSON with `id`, `content`, `embedded`
- [ ] `scripts/cli-wrapper.sh` is executable (`chmod +x`)
- [ ] `cli-wrapper.sh doctor --json` works from any working directory
- [ ] Agent can spawn `openbrain` as subprocess, parse JSON, handle exit code 1 on failure
- [ ] `openbrain --manifest --json` returns valid machine-readable tool manifest
- [ ] `openbrain --backfill --json` processes pending embeddings and returns `{ "backfilled": N, "remaining": M }`
- [ ] `openbrain search "nonexistent" --json` returns exit 0 with `results: []` (not an error)

### Phase 4 — MCP Interface (alternative, must follow Phase 2)
- [ ] Claude Code connects via `mcp-wrapper.sh`
- [ ] Claude Code `search_thoughts` tool returns results
- [ ] Multiple agents can connect simultaneously (share one brain)
- [ ] MCP server backfills pending embeddings on every tool call (verify by checking `needs_embedding = false` on staged thoughts after any tool call)

### Phase 5 — Setup Scripts
- [ ] Each `.sh` script runs without error in isolation

### Phase 6 — README (INDEPENDENT — no phase required)
- [ ] All setup steps are copy-pasteable
- [ ] Agent integration steps are accurate for Claude Code, Cursor