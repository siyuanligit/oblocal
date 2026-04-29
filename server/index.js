import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioTransport } from "@modelcontextprotocol/sdk/transports/stdio.js";
import pg from "pg";
import fs from "fs";
import os from "os";
import path from "path";
import { MAX_CONTENT_LENGTH } from "../lib/constants.js";
import { getEmbedding, extractMetadata, backfillPendingEmbeddings } from "../lib/ollama.js";

const { Pool } = pg;

let config;
try {
  const configPath = path.join(os.homedir(), ".openbrain", "config.json");
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch {
  config = {
    database_url: process.env.DATABASE_URL || "postgresql://postgres:openbrain@localhost:5432/openbrain",
    ollama_url: process.env.OLLAMA_URL || "http://localhost:11434",
    embedding_model: "nomic-embed-text",
    chat_model: process.env.CHAT_MODEL || "llama3.2-mini"
  };
}

const pgPool = new Pool({ connectionString: config.database_url });

function errResponse(code, error) {
  return { content: [{ type: "text", text: JSON.stringify({ success: false, error, code }) }] };
}

const server = new McpServer({
  name: "openbrain",
  version: "1.0.0"
});

server.tool(
  "search_thoughts",
  "Search thoughts using vector similarity",
  {
    query: { type: "string", description: "Search query" },
    limit: { type: "number", description: "Max results", default: 10 },
    threshold: { type: "number", description: "Similarity threshold", default: 0.7 }
  },
  async ({ query, limit = 10, threshold = 0.7 }) => {
    let embedding;
    try {
      embedding = await getEmbedding(query, config.ollama_url, config.embedding_model);
    } catch {
      return errResponse("OLLAMA_UNAVAILABLE", "Ollama unavailable — cannot generate query embedding.");
    }

    const result = await pgPool.query(
      `SELECT id, content, metadata, (1 - (embedding <=> $1::vector))::FLOAT AS similarity, created_at
       FROM thoughts
       WHERE 1 - (embedding <=> $1::vector) > $2
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [embedding, threshold, limit]
    );

    if (result.rows.length === 0) {
      const pending = await pgPool.query('SELECT count(*) FROM thoughts WHERE needs_embedding = true');
      const pendingCount = parseInt(pending.rows[0].count);
      let response = `No thoughts found matching '${query}'.`;
      if (pendingCount > 0) {
        response += ` Note: ${pendingCount} thought(s) are pending embedding (Ollama was unavailable at capture time).`;
      }
      return { content: [{ type: "text", text: response }] };
    }

    let response = "Search results:\n\n";
    for (const row of result.rows) {
      response += `[${row.similarity.toFixed(3)}] ${row.content}\n`;
      if (row.metadata?.topics?.length) response += `  Topics: ${row.metadata.topics.join(", ")}\n`;
      if (row.metadata?.people?.length) response += `  People: ${row.metadata.people.join(", ")}\n`;
      response += "\n";
    }

    return { content: [{ type: "text", text: response.trim() }] };
  }
);

server.tool(
  "list_thoughts",
  "List recent thoughts with optional filters",
  {
    type: { type: "string", description: "Filter by type", required: false },
    topic: { type: "string", description: "Filter by topic", required: false },
    person: { type: "string", description: "Filter by person mentioned", required: false },
    days: { type: "number", description: "Only show thoughts from last N days", required: false },
    limit: { type: "number", description: "Max results", default: 20 }
  },
  async ({ type, topic, person, days, limit = 20 }) => {
    let query = `SELECT content, metadata, created_at, needs_embedding FROM thoughts WHERE 1=1`;
    const params = [];
    let paramIdx = 1;

    if (days) {
      query += ` AND created_at >= now() - make_interval(days => $${paramIdx})`;
      params.push(parseInt(days));
      paramIdx++;
    }
    if (type) {
      query += ` AND metadata->>'type' = $${paramIdx}`;
      params.push(type);
      paramIdx++;
    }
    if (topic) {
      query += ` AND metadata->'topics' ? $${paramIdx}`;
      params.push(topic);
      paramIdx++;
    }
    if (person) {
      query += ` AND metadata->'people' ? $${paramIdx}`;
      params.push(person);
      paramIdx++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIdx}`;
    params.push(limit);

    const result = await pgPool.query(query, params);

    if (result.rows.length === 0) {
      return { content: [{ type: "text", text: "No thoughts found." }] };
    }

    let response = "";
    for (const row of result.rows) {
      const pendingNote = row.needs_embedding ? " (pending embedding)" : "";
      response += `[${row.created_at.toISOString()}]${pendingNote}\n`;
      response += `${row.content}\n`;
      if (row.metadata?.topics?.length) response += `  Topics: ${row.metadata.topics.join(", ")}\n`;
      if (row.metadata?.type) response += `  Type: ${row.metadata.type}\n`;
      response += "\n";
    }

    return { content: [{ type: "text", text: response.trim() }] };
  }
);

server.tool(
  "thought_stats",
  "Get aggregate statistics about thoughts",
  {},
  async () => {
    const statsResult = await pgPool.query(`
      SELECT
        COUNT(*) FILTER (WHERE true) as total,
        COUNT(*) FILTER (WHERE needs_embedding = true AND embedding IS NULL) as pending,
        COUNT(*) FILTER (WHERE embedding IS NOT NULL) as with_embeddings
      FROM thoughts
    `);

    const topTypes = await pgPool.query(`
      SELECT metadata->>'type' as type, count(*) as count
      FROM thoughts
      WHERE metadata->>'type' IS NOT NULL
      GROUP BY type
      ORDER BY count DESC
      LIMIT 5
    `);

    const topTopics = await pgPool.query(`
      SELECT topic, count(*) as count
      FROM thoughts, jsonb_array_elements_text(metadata->'topics') as topic
      GROUP BY topic
      ORDER BY count DESC
      LIMIT 10
    `);

    const recentActivity = await pgPool.query(`
      SELECT date_trunc('day', created_at) as day, count(*)
      FROM thoughts
      WHERE created_at >= now() - interval '30 days'
      GROUP BY day
      ORDER BY day DESC
    `);

    let response = "Thought Statistics\n==================\n";
    response += `Total thoughts: ${statsResult.rows[0].total}\n`;
    response += `With embeddings: ${statsResult.rows[0].with_embeddings}\n`;
    response += `Pending embedding: ${statsResult.rows[0].pending}\n\n`;

    response += "Top Types:\n";
    for (const row of topTypes.rows) {
      response += `  ${row.type}: ${row.count}\n`;
    }

    response += "\nTop Topics:\n";
    for (const row of topTopics.rows) {
      response += `  ${row.topic}: ${row.count}\n`;
    }

    response += "\nLast 30 days activity:\n";
    for (const row of recentActivity.rows) {
      response += `  ${row.day.toISOString().split('T')[0]}: ${row.count}\n`;
    }

    return { content: [{ type: "text", text: response }] };
  }
);

server.tool(
  "backfill_thoughts",
  "Process pending embeddings that failed during capture",
  {},
  async () => {
    try {
      const backfilled = await backfillPendingEmbeddings(pgPool, config.ollama_url, config.embedding_model);
      const remaining = await pgPool.query('SELECT count(*) FROM thoughts WHERE needs_embedding = true AND embedding IS NULL');
      const count = parseInt(remaining.rows[0].count);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, backfilled, remaining: count }) }] };
    } catch (err) {
      return errResponse("BACKFILL_FAILED", err.message);
    }
  }
);

server.tool(
  "capture_thought",
  "Capture a new thought with automatic embedding and metadata extraction",
  {
    content: { type: "string", description: "The thought content to capture" }
  },
  async ({ content }) => {
    if (content.length > MAX_CONTENT_LENGTH) {
      return errResponse("CONTENT_TOO_LONG", `Content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`);
    }

    const metadata = await extractMetadata(content, config.ollama_url, config.chat_model);

    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');

      let upsertResult;
      try {
        upsertResult = await client.query(
          `SELECT * FROM upsert_thought($1::text, $2::jsonb)`,
          [content, JSON.stringify(metadata)]
        );
      } catch (err) {
        await client.query('ROLLBACK');
        return errResponse("CAPTURE_FAILED", err.message);
      }

      const { id } = upsertResult.rows[0];

      let embeddingSuccess = false;
      try {
        const embedding = await getEmbedding(content, config.ollama_url, config.embedding_model);
        await client.query(
          'UPDATE thoughts SET embedding = $1, needs_embedding = false WHERE id = $2',
          [embedding, id]
        );
        embeddingSuccess = true;
      } catch (err) {
        await client.query(
          'UPDATE thoughts SET needs_embedding = true WHERE id = $1 AND embedding IS NULL',
          [id]
        );
      }

      await client.query('COMMIT');

      const msg = embeddingSuccess
        ? `Captured ${metadata.type || "observation"} — stored with embedding.`
        : `Captured ${metadata.type || "observation"} — embedding staged for later (Ollama unavailable).`;

      return { content: [{ type: "text", text: JSON.stringify({ success: true, id, message: msg }) }] };
    } catch (err) {
      await client.query('ROLLBACK');
      return errResponse("CAPTURE_FAILED", err.message);
    } finally {
      client.release();
    }
  }
);

const transport = new StdioTransport();
server.connect(transport).catch(err => {
  console.error("Failed to connect MCP server:", err);
  process.exit(1);
});
