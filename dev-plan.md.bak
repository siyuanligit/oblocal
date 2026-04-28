# Open Brain — local-version Development Plan

## What We're Building

A fully local Open Brain: your own PostgreSQL + pgvector database, with two ways to interact — **CLI** (direct terminal, no AI agent needed) or **MCP server** (connects coding agents like Claude Code, Cursor). No external APIs, no cloud services.

**CLI is the primary interface.** You can use the CLI directly for all operations (capture, search, list, stats). The MCP server exists as an alternative for coding agents that prefer stdio transport. Both expose the same 4 capabilities.

- **CLI** — runs on host machine. Direct terminal access. Preferred.
- **MCP server** — runs in Docker, connects to coding agents via stdio transport. Alternative to CLI for AI-mediated access.

---

## Design Decisions (Confirmed)

| Decision | Choice |
|---|---|
| **Database** | PostgreSQL + pgvector in Docker. Native install instructions also provided. |
| **Embedding** | Ollama `nomic-embed-text` (1536-dim) — runs locally, no external API calls |
| **Metadata extraction** | Ollama `llama3.2-mini` (JSON mode) — configurable via `config.json` |
| **CLI** | Primary interface — standalone, fully independent, same 4 capabilities as MCP |
| **MCP server** | Alternative — always-on Docker container, stdio transport for coding agents |
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
│   └── mcp-wrapper.sh           # docker compose exec -i mcp (service name)
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
│   └── 05-connect-agents.sh    # MCP agent integration guide
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

## Phase 3: CLI Tool — DEPENDS ON: Phase 1 (independent of Phase 2)

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
| `openbrain search "query"` | Generate embedding via Ollama, run `match_thoughts` RPC directly — fully autonomous, no agent required | 0 success (even if no results), 1 search failed |
| `openbrain list --limit 10` | List recent thoughts | 0 success, 1 db error |
| `openbrain stats` | Show brain overview | 0 success, 1 db error |
| `openbrain doctor` | Check Postgres, Ollama, config file connectivity | 0 all green, 1 one or more checks failed |
| `openbrain init` | Create ~/.openbrain/config.json | 0 success, 1 already exists or write error |

All commands support `--json` flag for machine-readable output ( scripting). Default output is plain text.

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

---

## Phase 4: Agent Integration — DEPENDS ON: Phase 2

### 4.1 `scripts/mcp-wrapper.sh`

```bash
#!/bin/bash
# Uses docker compose exec (service name, not container name) — no hardcoded container name
docker compose exec -i mcp node /app/index.js
```

This wrapper pipes stdin/stdout from the Docker container to the calling agent. Claude Code, Cursor, and other stdio-based agents use this to communicate with the containerized MCP server.

### 4.2 Claude Code integration

In `~/.claude/mcp.json`:
```json
{
  "mcpServers": {
    "openbrain": {
      "command": "/path/to/local-version/scripts/mcp-wrapper.sh"
    }
  }
}
```

### 4.3 Cursor / VS Code Copilot / Windsurf

Same wrapper script. These clients also support stdio MCP.

### 4.4 Multiple agents sharing one brain

All agents connect to the same Docker container via stdio wrapper. The `source` column in `thoughts` tracks which agent captured each entry.

---

## Phase 5: Setup Automation — DEPENDS ON: Phase 1

**Setup order (user runs manually, in sequence):**
```
1. openbrain init                   → creates ~/.openbrain/config.json (before starting docker)
2. 01-start-docker.sh              → starts postgres + mcp containers (NO migrations)
3. 02-run-migrations.sh            → user-initiated schema migration (Supabase-style)
4. 03-setup-ollama.sh              → install Ollama + pull models
5. 04-setup-cli.sh                → npm install -g the CLI (if not installed in step 1)
6. 05-connect-agents.sh           → agent integration guide
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

Prints platform-specific instructions for Claude Code, Cursor, etc.

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

**Hard dependency chain:** Phase 1 → Phase 2/3/4/5 (sequential)
**Independent phases:** Phase 6 (README) — can be written at any time

```
Phase 1 (Docker + DB)         ← blocks all other phases
    ↓
Phase 2 (MCP server)          ← needs Phase 1
Phase 3 (CLI)                  ← needs Phase 1
Phase 5 (Setup scripts)        ← needs Phase 1
    ↓
Phase 4 (Agent integration)   ← needs Phase 2 (mcp-wrapper.sh)

Phase 6 (README)              ← INDEPENDENT — can start immediately
```

### Parallel Work Possible

| Agent | Can work on | Dependency |
|---|---|---|
| Agent A | Phase 2 (MCP server) | Only Phase 1 |
| Agent B | Phase 3 (CLI) | Only Phase 1 |
| Agent C | Phase 6 (README) | **Nothing** |

Agent A and Agent B can work **simultaneously** after Phase 1 completes. Agent C can start immediately.

---

## Implementation Order

```
Phase 1 → docker-compose.yml + Dockerfile.mcp + schema/*.sql (blocks everything)
Phase 2 → server/index.js (MCP server, stdio)         ┐ independent
Phase 3 → cli/src/index.js                             ┘ after Phase 1
Phase 4 → scripts/mcp-wrapper.sh                        (after Phase 2)
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

### Phase 3 — CLI (independent of Phase 2)
- [ ] `npm install -g` the CLI
- [ ] `openbrain capture "test"` stores thought with Ollama embedding
- [ ] `openbrain list` returns stored thoughts
- [ ] `openbrain doctor` reports all green

### Phase 4 — Agent Integration (must follow Phase 2)
- [ ] Claude Code connects via `mcp-wrapper.sh`
- [ ] Claude Code `search_thoughts` tool returns results
- [ ] Multiple agents can connect simultaneously (share one brain)

### Phase 5 — Setup Scripts
- [ ] Each `.sh` script runs without error in isolation

### Phase 6 — README (INDEPENDENT — no phase required)
- [ ] All setup steps are copy-pasteable
- [ ] Agent integration steps are accurate for Claude Code, Cursor