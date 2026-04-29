#!/usr/bin/env node
import { Command } from 'commander';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { MAX_CONTENT_LENGTH } from '../lib/constants.js';
import { getEmbedding, extractMetadata, backfillPendingEmbeddings } from '../lib/ollama.js';

const { Pool } = pg;

const CONFIG_PATH = path.join(os.homedir(), '.openbrain', 'config.json');

function loadConfig() {
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function saveConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function checkOllamaModel(ollamaUrl, model) {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`);
    if (!response.ok) return false;
    const data = await response.json();
    return data.models && data.models.some(m => m.name === model);
  } catch {
    return false;
  }
}

function errResponse(code, error) {
  return { success: false, error, code };
}

function outputJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

async function backfill(opts) {
  const config = loadConfig();
  if (!config) {
    if (opts.json) outputJson(errResponse('CONFIG_NOT_FOUND', 'Config not found. Run openbrain init first.'));
    else console.error('Error: Config not found. Run openbrain init first.');
    return 1;
  }

  try {
    const pool = new Pool({ connectionString: config.database_url });
    const backfilled = await backfillPendingEmbeddings(pool, config.ollama_url, config.embedding_model);
    const remaining = await pool.query('SELECT count(*) FROM thoughts WHERE needs_embedding = true AND embedding IS NULL');
    await pool.end();

    if (opts.json) {
      outputJson({ success: true, backfilled, remaining: parseInt(remaining.rows[0].count) });
    } else {
      console.log(`Backfilled ${backfilled} embeddings. ${remaining.rows[0].count} remaining.`);
    }
    return 0;
  } catch (err) {
    if (opts.json) outputJson(errResponse('BACKFILL_FAILED', err.message));
    else console.error(`Backfill failed: ${err.message}`);
    return 1;
  }
}

async function capture(text, opts) {
  const config = loadConfig();
  if (!config) {
    if (opts.json) outputJson(errResponse('CONFIG_NOT_FOUND', 'Config not found. Run openbrain init first.'));
    else console.error('Error: Config not found. Run openbrain init first.');
    return 1;
  }

  if (text.length > MAX_CONTENT_LENGTH) {
    if (opts.json) outputJson(errResponse('CONTENT_TOO_LONG', `Content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`));
    else console.error(`Error: Content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters`);
    return 1;
  }

  let pool = null;
  try {
    pool = new Pool({ connectionString: config.database_url });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const metadata = await extractMetadata(text, config.ollama_url, config.chat_model);

      const fpResult = await client.query(
        `SELECT encode(sha256(convert_to(lower(trim(regexp_replace($1, '\\s+', ' ', 'g'))), 'UTF8')), 'hex') as fp`,
        [text]
      );
      const fp = fpResult.rows[0].fp;

      const upsert = await client.query(
        `INSERT INTO thoughts (content, content_fingerprint, metadata)
         VALUES ($1, $2, $3)
         ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
         SET updated_at = now(),
             metadata = thoughts.metadata || COALESCE(EXCLUDED.metadata, '{}'::jsonb)
         RETURNING id, created_at`,
        [text, fp, JSON.stringify(metadata)]
      );

      const { id, created_at } = upsert.rows[0];

      let embedded = false;
      try {
        const embedding = await getEmbedding(text, config.ollama_url, config.embedding_model);
        await client.query('UPDATE thoughts SET embedding = $1, needs_embedding = false WHERE id = $2', [embedding, id]);
        embedded = true;
      } catch (err) {
        if (!opts.json) console.error(`  [capture] Ollama unavailable, embedding staged: ${err.message}`);
        await client.query('UPDATE thoughts SET needs_embedding = true WHERE id = $1 AND embedding IS NULL', [id]);
      }

      await client.query('COMMIT');

      if (opts.json) {
        outputJson({ success: true, id, content: text, created_at, embedded, metadata });
      } else {
        console.log(`Captured: "${text}" (${id})`);
      }
      return 0;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (opts.json) outputJson(errResponse('CAPTURE_FAILED', err.message));
    else console.error(`Capture failed: ${err.message}`);
    return 1;
  } finally {
    if (pool) await pool.end();
  }
}

async function search(query, opts) {
  const config = loadConfig();
  if (!config) {
    if (opts.json) outputJson(errResponse('CONFIG_NOT_FOUND', 'Config not found. Run openbrain init first.'));
    else console.error('Error: Config not found. Run openbrain init first.');
    return 1;
  }

  try {
    const pool = new Pool({ connectionString: config.database_url });
    const embedding = await getEmbedding(query, config.ollama_url, config.embedding_model);

    const limit = parseInt(opts.limit) || 10;
    const threshold = parseFloat(opts.threshold) || 0.7;

    const result = await pool.query(
      `SELECT id, content, metadata, (1 - (embedding <=> $1))::FLOAT AS similarity, created_at
       FROM thoughts
       WHERE 1 - (embedding <=> $1) > $2
       ORDER BY embedding <=> $1
       LIMIT $3`,
      [embedding, threshold, limit]
    );

    await pool.end();

    if (opts.json) {
      outputJson({ success: true, results: result.rows, count: result.rows.length });
    } else {
      if (result.rows.length === 0) {
        console.log(`No thoughts found matching "${query}".`);
      } else {
        result.rows.forEach(row => {
          console.log(`[${(row.similarity * 100).toFixed(1)}%] ${row.content}`);
        });
      }
    }
    return 0;
  } catch (err) {
    if (opts.json) outputJson(errResponse('SEARCH_FAILED', err.message));
    else console.error(`Search failed: ${err.message}`);
    return 1;
  }
}

async function listThoughts(opts) {
  const config = loadConfig();
  if (!config) {
    if (opts.json) outputJson(errResponse('CONFIG_NOT_FOUND', 'Config not found. Run openbrain init first.'));
    else console.error('Error: Config not found. Run openbrain init first.');
    return 1;
  }

  try {
    const pool = new Pool({ connectionString: config.database_url });
    const limit = parseInt(opts.limit) || 10;

    const result = await pool.query(
      `SELECT id, content, metadata, created_at, needs_embedding
       FROM thoughts
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    await pool.end();

    if (opts.json) {
      outputJson({ success: true, thoughts: result.rows, count: result.rows.length });
    } else {
      if (result.rows.length === 0) {
        console.log('No thoughts stored yet.');
      } else {
        result.rows.forEach(row => {
          const pending = row.needs_embedding ? ' (pending embedding)' : '';
          console.log(`[${row.created_at}] ${row.content}${pending}`);
        });
      }
    }
    return 0;
  } catch (err) {
    if (opts.json) outputJson(errResponse('LIST_FAILED', err.message));
    else console.error(`List failed: ${err.message}`);
    return 1;
  }
}

async function stats(opts) {
  const config = loadConfig();
  if (!config) {
    if (opts.json) outputJson(errResponse('CONFIG_NOT_FOUND', 'Config not found. Run openbrain init first.'));
    else console.error('Error: Config not found. Run openbrain init first.');
    return 1;
  }

  try {
    const pool = new Pool({ connectionString: config.database_url });

    const statsResult = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE true) as total,
        COUNT(*) FILTER (WHERE needs_embedding = true AND embedding IS NULL) as pending,
        COUNT(*) FILTER (WHERE embedding IS NOT NULL) as with_embeddings
      FROM thoughts
    `);

    const typeResult = await pool.query(
      `SELECT metadata->>'type' as type, COUNT(*) as count
       FROM thoughts
       WHERE metadata->>'type' IS NOT NULL
       GROUP BY type
       ORDER BY count DESC
       LIMIT 5`
    );

    const topicResult = await pool.query(
      `SELECT jsonb_array_elements_text(metadata->'topics') as topic, COUNT(*) as count
       FROM thoughts
       WHERE metadata->'topics' IS NOT NULL
       GROUP BY topic
       ORDER BY count DESC
       LIMIT 10`
    );

    await pool.end();

    const statsData = {
      success: true,
      total_thoughts: parseInt(statsResult.rows[0].total),
      pending_embeddings: parseInt(statsResult.rows[0].pending),
      top_types: typeResult.rows,
      top_topics: topicResult.rows
    };

    if (opts.json) {
      outputJson(statsData);
    } else {
      console.log(`Total thoughts: ${statsData.total_thoughts}`);
      console.log(`Pending embeddings: ${statsData.pending_embeddings}`);
      if (typeResult.rows.length > 0) {
        console.log('Top types:');
        typeResult.rows.forEach(r => console.log(`  - ${r.type}: ${r.count}`));
      }
      if (topicResult.rows.length > 0) {
        console.log('Top topics:');
        topicResult.rows.forEach(r => console.log(`  - ${r.topic}: ${r.count}`));
      }
    }
    return 0;
  } catch (err) {
    if (opts.json) outputJson(errResponse('STATS_FAILED', err.message));
    else console.error(`Stats failed: ${err.message}`);
    return 1;
  }
}

async function doctor(opts) {
  const checks = [];

  const config = loadConfig();
  if (!config) {
    if (opts.json) {
      outputJson({ success: false, passed: false, checks: [{ name: 'config_file', passed: false, message: 'Config file not found at ~/.openbrain/config.json' }] });
    } else {
      console.log('FAIL: Config file not found at ~/.openbrain/config.json');
    }
    return 1;
  }

  checks.push({ name: 'config_file', passed: true, message: 'Config file exists and is valid JSON' });

  try {
    const testPool = new Pool({ connectionString: config.database_url });
    const testClient = await testPool.connect();
    await testClient.query('SELECT 1');
    testClient.release();
    await testPool.end();
    checks.push({ name: 'postgres', passed: true, message: 'Postgres is reachable' });
  } catch (err) {
    checks.push({ name: 'postgres', passed: false, message: `Postgres connection failed: ${err.message}` });
    if (opts.json) outputJson({ success: false, passed: false, checks });
    else console.log(`FAIL: Postgres - ${err.message}`);
    return 1;
  }

  try {
    const response = await fetch(`${config.ollama_url}/api/tags`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    checks.push({ name: 'ollama', passed: true, message: 'Ollama is reachable' });
  } catch (err) {
    checks.push({ name: 'ollama', passed: false, message: `Ollama connection failed: ${err.message}` });
    if (opts.json) outputJson({ success: false, passed: false, checks });
    else console.log(`FAIL: Ollama - ${err.message}`);
    return 1;
  }

  const embeddingModelAvailable = await checkOllamaModel(config.ollama_url, config.embedding_model);
  if (!embeddingModelAvailable) {
    checks.push({ name: 'embedding_model', passed: false, message: `Model ${config.embedding_model} not pulled. Run: ollama pull ${config.embedding_model}` });
    if (opts.json) outputJson({ success: false, passed: false, checks });
    else console.log(`FAIL: Embedding model ${config.embedding_model} not pulled. Run: ollama pull ${config.embedding_model}`);
    return 1;
  }
  checks.push({ name: 'embedding_model', passed: true, message: `${config.embedding_model} is available` });

  const chatModelAvailable = await checkOllamaModel(config.ollama_url, config.chat_model);
  if (!chatModelAvailable) {
    checks.push({ name: 'chat_model', passed: false, message: `Model ${config.chat_model} not pulled. Run: ollama pull ${config.chat_model}` });
    if (opts.json) outputJson({ success: false, passed: false, checks });
    else console.log(`FAIL: Chat model ${config.chat_model} not pulled. Run: ollama pull ${config.chat_model}`);
    return 1;
  }
  checks.push({ name: 'chat_model', passed: true, message: `${config.chat_model} is available` });

  if (opts.json) {
    outputJson({ success: true, passed: true, checks });
  } else {
    console.log('All checks passed:');
    checks.forEach(c => console.log(`  - ${c.name}: ${c.message}`));
  }
  return 0;
}

async function init(opts) {
  const configPath = CONFIG_PATH;

  if (fs.existsSync(configPath) && !opts.force) {
    console.error('Config already exists. Use --force to overwrite or edit ~/.openbrain/config.json directly.');
    return 1;
  }

  const defaultConfig = {
    database_url: 'postgresql://postgres:openbrain@localhost:5432/openbrain',
    ollama_url: 'http://localhost:11434',
    embedding_model: 'nomic-embed-text',
    chat_model: 'llama3.2-mini'
  };

  if (opts.json) {
    outputJson({ success: true, config: defaultConfig, path: configPath });
  } else {
    console.log('Creating default config at ~/.openbrain/config.json');
    console.log(`  database_url: ${defaultConfig.database_url}`);
    console.log(`  ollama_url: ${defaultConfig.ollama_url}`);
    console.log(`  embedding_model: ${defaultConfig.embedding_model}`);
    console.log(`  chat_model: ${defaultConfig.chat_model}`);
    console.log('\n  ⚠️  WARNING: Using default credentials. Change \'openbrain\' password for production use.');
  }

  saveConfig(defaultConfig);
  if (!opts.json) console.log('Config created. Edit ~/.openbrain/config.json to customize.');
  return 0;
}

const program = new Command();

program.name('openbrain').description('Open Brain CLI - local AI memory').version('1.0.0');

program.command('capture').description('Store a thought with Ollama embedding').argument('<text>').option('--json', 'Output as JSON').action(capture);

program.command('search').description('Search thoughts by query').argument('<query>').option('--json', 'Output as JSON').option('--limit <number>', 'Max results', '10').option('--threshold <number>', 'Similarity threshold', '0.7').action(search);

program.command('list').description('List recent thoughts').option('--json', 'Output as JSON').option('--limit <number>', 'Max results', '10').action(listThoughts);

program.command('stats').description('Show brain overview').option('--json', 'Output as JSON').action(stats);

program.command('doctor').description('Check Postgres, Ollama, and config connectivity').option('--json', 'Output as JSON').action(doctor);

program.command('init').description('Create ~/.openbrain/config.json').option('--force', 'Overwrite existing config').action(init);

program.command('backfill').description('Process pending embeddings').option('--json', 'Output as JSON').action(backfill);

program.parse();
