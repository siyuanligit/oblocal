# Build Your Local Open Brain

Zero cloud services. Your own PostgreSQL + pgvector database running in Docker on your machine. Your AI coding agents connect via stdio — no API keys, no external calls.

> **Original project:** [OB1 by NateBJones](https://github.com/NateBJones-Projects/OB1) — This is a local-first fork that replaces Supabase/OpenRouter dependencies with Docker + Ollama running entirely on your machine.

---

![Step 1](https://img.shields.io/badge/Step_1-Install_Docker-1E88E5?style=for-the-badge)
![Step 2](https://img.shields.io/badge/Step_2-Start_Containers-43A047?style=for-the-badge)
![Step 3](https://img.shields.io/badge/Step_3-Run_Migrations-8E24AA?style=for-the-badge)
![Step 4](https://img.shields.io/badge/Step_4-Setup_Ollama-FB8C00?style=for-the-badge)
![Step 5](https://img.shields.io/badge/Step_5-Install_CLI-00897B?style=for-the-badge)
![Step 6](https://img.shields.io/badge/Step_6-Verify_Setup-5C6BC0?style=for-the-badge)
![Step 7](https://img.shields.io/badge/Step_7-Connect_Agents-D555555?style=for-the-badge)
![Step 8](https://img.shields.io/badge/Step_8-Use_It-8E24AA?style=for-the-badge)

---

![Step 1](https://img.shields.io/badge/Step_1-Install_Docker-1E88E5?style=for-the-badge)

Docker runs PostgreSQL + pgvector in a container on your machine. This guide uses Docker Desktop for consistent cross-platform behavior.

**macOS / Windows:** Install [Docker Desktop](https://www.docker.com/products/docker-desktop/).

**Linux:** Install Docker via your package manager:

```bash
# Ubuntu/Debian
sudo apt-get install docker.io docker-compose

# Fedora
sudo dnf install docker docker-compose
```

Start Docker Desktop (or the docker daemon on Linux) and confirm it's running:

```bash
docker info
```

✅ **Done when:** `docker info` shows Docker is running without errors.

---

![Step 2](https://img.shields.io/badge/Step_2-Start_Containers-43A047?style=for-the-badge)

The `docker-compose.yml` starts two services: **postgres** (your database) and **mcp** (the MCP server, always-on).

From the `local-version/` folder:

```bash
docker compose up -d postgres
docker compose up -d mcp
docker compose ps
```

✅ **Done when:** Both containers show as `healthy` or `running` in `docker compose ps`.

---

![Step 3](https://img.shields.io/badge/Step_3-Run_Migrations-8E24AA?style=for-the-badge)

Run the schema migrations against your Postgres container:

```bash
docker compose exec -T postgres psql -U postgres -d openbrain -f /schema/001-thoughts.sql
docker compose exec -T postgres psql -U postgres -d openbrain -f /schema/002-match-thoughts.sql
docker compose exec -T postgres psql -U postgres -d openbrain -f /schema/003-upsert-thought.sql
docker compose exec -T postgres psql -U postgres -d openbrain -f /schema/004-backfill-embeddings.sql
```

Verify the tables were created:

```bash
docker compose exec postgres psql -U postgres -d openbrain -c '\dt'
```

✅ **Done when:** `thoughts` table and `match_thoughts`, `upsert_thought`, `backfill_pending_embeddings` functions exist.

---

![Step 4](https://img.shields.io/badge/Step_4-Setup_Ollama-FB8C00?style=for-the-badge)

Ollama runs AI models locally — no external API calls needed. We pull two models:

- **`nomic-embed-text`** — generates the 1536-dimensional embedding vectors for semantic search
- **`llama3.2-mini`** — extracts metadata from captured thoughts (type, topics, people, action items)

**macOS / Linux:**

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull nomic-embed-text
ollama pull llama3.2-mini
```

**Windows:** Download Ollama from [ollama.com](https://ollama.com), then in PowerShell:

```powershell
ollama pull nomic-embed-text
ollama pull llama3.2-mini
```

Verify both models are available:

```bash
ollama list
```

✅ **Done when:** `ollama list` shows both `nomic-embed-text` and `llama3.2-mini` in the model list.

---

![Step 5](https://img.shields.io/badge/Step_5-Install_CLI-00897B?style=for-the-badge)

The CLI is your primary interface — it runs on your host machine (not in Docker). It supports capture, search, list, stats, and a doctor command to verify connectivity.

**Requires:** Node.js 18+ on the host machine.

```bash
cd ../cli && npm install -g .
openbrain init
```

`openbrain init` creates `~/.openbrain/config.json` with defaults:

```json
{
  "database_url": "postgresql://postgres:openbrain@localhost:5432/openbrain",
  "ollama_url": "http://localhost:11434",
  "embedding_model": "nomic-embed-text",
  "chat_model": "llama3.2-mini"
}
```

Re-run `openbrain init` any time to update the configuration.

✅ **Done when:** `openbrain --version` prints the version without errors.

---

![Step 6](https://img.shields.io/badge/Step_6-Verify_Setup-5C6BC0?style=for-the-badge)

Run the doctor check to confirm all services are reachable:

```bash
openbrain doctor
```

Capture a test thought:

```bash
openbrain capture "test thought from local setup verification"
```

List recent thoughts:

```bash
openbrain list --limit 5
```

✅ **Done when:** `openbrain doctor` reports all green, and `openbrain list` shows the captured test thought.

---

![Step 7](https://img.shields.io/badge/Step_7-Connect_Agents-D555555?style=for-the-badge)

The MCP server runs in Docker and communicates via stdio. The wrapper script pipes stdin/stdout between the container and your coding agent.

Add the MCP server to your agent's config. Replace `/path/to/local-version` with the actual path to your `local-version` folder:

**Claude Code** — in `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "openbrain": {
      "command": "/path/to/local-version/scripts/mcp-wrapper.sh"
    }
  }
}
```

**Cursor / VS Code Copilot / Windsurf** — same wrapper script in your client's MCP JSON config.

The wrapper script uses `docker compose exec` (service name, not container name), so it works regardless of what your containers are named:

```bash
#!/bin/bash
docker compose exec -i mcp node /app/index.js
```

Make the wrapper executable:

```bash
chmod +x scripts/mcp-wrapper.sh
```

✅ **Done when:** Your coding agent has access to the four Open Brain tools: `search_thoughts`, `list_thoughts`, `thought_stats`, `capture_thought`.

---

![Step 8](https://img.shields.io/badge/Step_8-Use_It-8E24AA?style=for-the-badge)

Ask your AI naturally. It picks the right tool automatically:

| Prompt | Tool Used |
| ------ | --------- |
| "Save this: decided to move the launch to March 15 because of the QA blockers" | capture_thought |
| "Remember that Marcus wants to move to the platform team" | capture_thought |
| "What did I capture about career changes?" | search_thoughts |
| "What did I capture this week?" | list_thoughts |
| "How many thoughts do I have?" | thought_stats |
| "Find my notes about the API redesign" | search_thoughts |
| "Show me my recent ideas" | list_thoughts |

Start with a test capture:

```
Remember this: Sarah mentioned she's thinking about leaving her job to start a consulting business
```

Then search for it:

```
What did I capture about Sarah?
```

✅ **Done when:** You've captured a test thought and successfully retrieved it via search.

---

## Comparison: Supabase vs. local-version

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

## Troubleshooting

**❌ Docker containers won't start**

Run `docker compose logs` to see what went wrong. Common issues:

- Port 5432 is already in use — stop the other service or change the port mapping in `docker-compose.yml`
- Docker Desktop isn't running — open Docker Desktop and wait for it to fully start

**❌ Ollama connection errors**

Make sure Ollama is running:

```bash
ollama list
```

If you get "connection refused", start Ollama:

```bash
ollama serve
```

Then pull the models again to confirm.

**❌ `openbrain doctor` reports Postgres unreachable**

Verify the container is running:

```bash
docker compose ps
```

Check the Postgres logs:

```bash
docker compose logs postgres
```

**❌ MCP tools not appearing in your coding agent**

Restart your agent after updating the MCP config. For Claude Code:

```bash
claude mcp list
```

Should show `openbrain` as a connected server. If not, verify the path to `mcp-wrapper.sh` is correct and the script is executable.

**❌ Search returns no results**

Make sure you've captured at least one thought first (Step 8). Try with a lower threshold:

```
search_thoughts with threshold 0.3
```

If no results still come back, check the Ollama logs for embedding generation errors.
