# Code Review: OBLocal

## 🔴 Critical Issues

### 1. No Rate Limiting / DoS Protection
Both CLI and MCP server will happily process unbounded amounts of text through Ollama. A malicious actor could exhaust Ollama resources.

**Recommendation:** Add per-request size limits (e.g., 10KB max) and rate limiting middleware.

---

### 2. Hardcoded Default Credentials
**Files:** `cli/src/index.js:423`, `server/index.js:16-17`

```javascript
database_url: 'postgresql://postgres:openbrain@localhost:5432/openbrain'
```

The CLI creates this by default in `~/.openbrain/config.json` if init is run. Should warn users to change defaults in production.

**Recommendation:** In production mode, fail if default password is detected and prompt user to set secure credentials.

---

### 3. Swallowed Errors in Backfill Loop
**Files:** `cli/src/index.js:123-125`, `server/index.js:76-78`

```javascript
} catch {
  // Leave needs_embedding = true, will retry next time
}
```

Silent failures make debugging difficult. Should at least log at verbose mode.

**Recommendation:**
```javascript
} catch (err) {
  console.error(`Backfill failed for thought ${row.id}:`, err.message);
}
```

---

## 🟡 Suggestions

### 1. Code Duplication Between CLI and Server
`getEmbedding`, `extractMetadata`, and `backfillPendingEmbeddings` are nearly identical in both `cli/src/index.js` and `server/index.js`.

**Recommendation:** Extract to shared module (e.g., `src/lib/`):
```
src/
  lib/
    ollama.js      # getEmbedding, extractMetadata
    database.js    # backfillPendingEmbeddings, pool management
  cli/
    index.js
  server/
    index.js
```

---

### 2. No Input Validation on Text Length
`capture()` accepts unbounded text but pgvector embeddings have practical limits (~8000 tokens for nomic-embed-text).

**Recommendation:** Add validation:
```javascript
const MAX_CONTENT_LENGTH = 10000;
if (text.length > MAX_CONTENT_LENGTH) {
  throw new Error(`Content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`);
}
```

---

### 3. Connection Pool Per CLI Command
`cli/src/index.js` creates a new `Pool()` for every command. The server keeps one global `pgPool` which is more efficient for high-frequency calls.

**Recommendation:** For CLI, this is acceptable given low frequency. For consistency, could reuse pool:
```javascript
let pool = null;
function getPool() {
  if (!pool) pool = new Pool({ connectionString: config.database_url });
  return pool;
}
```

---

### 4. JSON.parse Without Try-Catch in Server
**File:** `server/index.js:59`

```javascript
return JSON.parse(data.message.content);
```

If Ollama returns malformed JSON, this crashes. The CLI handles this correctly (line 78) but server lacks try-catch.

**Recommendation:**
```javascript
try {
  return JSON.parse(data.message.content);
} catch {
  return { topics: ["uncategorized"], type: "observation" };
}
```

---

### 5. Missing Transaction Boundaries
`capture()` in CLI (lines 163-181) does two separate queries (upsert then update). If process crashes between them, state is inconsistent.

**Recommendation:** Wrap in transaction:
```javascript
const client = await pool.connect();
try {
  await client.query('BEGIN');
  // ... operations ...
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

---

### 6. Inconsistent Error Handling
- `capture()` returns `embedded: false` on failure but some errors (like DB connection failure) return exit code 1 with no JSON body.
- `server/index.js` returns error messages but doesn't set error status codes in the MCP response.

**Recommendation:** Standardize error response format with `error` field and appropriate HTTP-like codes.

---

### 7. Metadata Extraction Prompt Injection
The system prompt in `extractMetadata` could be manipulated if user text contains JSON-like structures.

**Recommendation:** Escape or sanitize user input before inserting into prompt, or use a more robust prompt structure that doesn't embed raw user text.

---

## ✅ Good Practices

### 1. Parameterized SQL Queries
All database queries use `$1`, `$2` placeholders, preventing SQL injection. Example from `cli/src/index.js:163-170`:
```javascript
const upsert = await pool.query(
  `INSERT INTO thoughts (content, content_fingerprint, metadata)
   VALUES ($1, $2, $3)
   ON CONFLICT ...`,
  [text, fp, JSON.stringify(metadata)]
);
```

---

### 2. Graceful Degradation on Ollama Failure
Both implementations set `needs_embedding = true` and stage for later backfill when Ollama is unavailable. This is a solid resilience pattern.

**From `cli/src/index.js:180-182`:**
```javascript
} catch {
  await pool.query('UPDATE thoughts SET needs_embedding = true WHERE id = $1 AND embedding IS NULL', [id]);
}
```

---

### 3. Config File Location via `os.homedir()`
Properly uses home directory for config storage (`~/.openbrain/config.json`).

---

### 4. Recursive Directory Creation
```javascript
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}
```

---

### 5. CLI `--json` Flag Consistency
Both output modes available and consistent across commands.

---

### 6. Backfill Processing in Server on Every Tool Call
Smart design — ensures embeddings eventually complete without requiring explicit user action.

---

### 7. Vector Similarity Search with Threshold
Proper use of `<=>` operator with threshold filtering.

---

### 8. MCP Server Transport Lifecycle
Properly handles `server.connect(transport)` with error handling and exit code on failure.

---

### 9. Modular Function Design
Each operation (`capture`, `search`, `list`, `stats`, `doctor`) is cleanly separated.

---

## Summary

| Category | Status |
|---|---|
| Security | ⚠️ Minor - hardcoded defaults, no rate limiting |
| Performance | ⚠️ Minor - no input bounds, connection per CLI call |
| Code Quality | ⚠️ Duplication between CLI and server |
| Architecture | ✅ Good separation, graceful degradation |
| Testing | ❌ No tests (per project spec) |