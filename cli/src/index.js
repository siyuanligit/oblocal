#!/usr/bin/env node
import { Command } from 'commander';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

async function getEmbedding(text, ollamaUrl, model = 'nomic-embed-text') {
  const response = await fetch(`${ollamaUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text })
  });
  if (!response.ok) {
    throw new Error(`Ollama embedding failed: ${response.statusText}`);
  }
  const data = await response.json();
  return data.embedding;
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

function output(format, data) {
  if (format === 'json') {
    console.log(JSON.stringify(data, null, 2));
  } else {
    if (Array.isArray(data)) {
      data.forEach(item => console.log(item));
    } else if (typeof data === 'object') {
      Object.entries(data).forEach(([key, value]) => {
        console.log(`${key}: ${value}`);
      });
    } else {
      console.log(data);
    }
  }
}

async function capture(text, opts) {
  const config = loadConfig();
  if (!config) {
    console.error('Error: Config not found. Run openbrain init first.');
    return 1;
  }

  try {
    const pool = new Pool({ connectionString: config.database_url });
    const embedding = await getEmbedding(text, config.ollama_url, config.embedding_model);

    const result = await pool.query(
      `INSERT INTO thoughts (content, embedding, metadata, content_fingerprint)
       VALUES ($1, $2, '{}', encode(sha256(convert_to(lower(trim(regexp_replace($1, '\\s+', ' ', 'g'))), 'UTF8')), 'hex'))
       ON CONFLICT (content_fingerprint) WHERE content_fingerprint IS NOT NULL DO UPDATE
       SET updated_at = now()
       RETURNING id, created_at`,
      [text, embedding]
    );

    await pool.end();

    const row = result.rows[0];
    if (opts.json) {
      output('json', { id: row.id, content: text, created_at: row.created_at, embedded: true });
    } else {
      console.log(`Captured: "${text}" (${row.id})`);
    }
    return 0;
  } catch (err) {
    console.error(`Capture failed: ${err.message}`);
    return 1;
  }
}

async function search(query, opts) {
  const config = loadConfig();
  if (!config) {
    console.error('Error: Config not found. Run openbrain init first.');
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
      output('json', { results: result.rows, count: result.rows.length });
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
    console.error(`Search failed: ${err.message}`);
    return 1;
  }
}

async function listThoughts(opts) {
  const config = loadConfig();
  if (!config) {
    console.error('Error: Config not found. Run openbrain init first.');
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
      output('json', { thoughts: result.rows, count: result.rows.length });
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
    console.error(`List failed: ${err.message}`);
    return 1;
  }
}

async function stats(opts) {
  const config = loadConfig();
  if (!config) {
    console.error('Error: Config not found. Run openbrain init first.');
    return 1;
  }

  try {
    const pool = new Pool({ connectionString: config.database_url });

    const totalResult = await pool.query('SELECT COUNT(*) as total FROM thoughts');
    const pendingResult = await pool.query('SELECT COUNT(*) as pending FROM thoughts WHERE needs_embedding = true AND embedding IS NULL');

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
      total_thoughts: parseInt(totalResult.rows[0].total),
      pending_embeddings: parseInt(pendingResult.rows[0].pending),
      top_types: typeResult.rows,
      top_topics: topicResult.rows
    };

    if (opts.json) {
      output('json', statsData);
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
    console.error(`Stats failed: ${err.message}`);
    return 1;
  }
}

async function doctor(opts) {
  const checks = [];

  const config = loadConfig();
  if (!config) {
    if (opts.json) {
      output('json', { passed: false, checks: [{ name: 'config_file', passed: false, message: 'Config file not found at ~/.openbrain/config.json' }] });
    } else {
      console.log('FAIL: Config file not found at ~/.openbrain/config.json');
    }
    return 1;
  }

  checks.push({ name: 'config_file', passed: true, message: 'Config file exists and is valid JSON' });

  try {
    const pool = new Pool({ connectionString: config.database_url });
    await pool.query('SELECT 1');
    await pool.end();
    checks.push({ name: 'postgres', passed: true, message: 'Postgres is reachable' });
  } catch (err) {
    checks.push({ name: 'postgres', passed: false, message: `Postgres connection failed: ${err.message}` });
    if (opts.json) {
      output('json', { passed: false, checks });
    } else {
      console.log(`FAIL: Postgres - ${err.message}`);
    }
    return 1;
  }

  try {
    const response = await fetch(`${config.ollama_url}/api/tags`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    checks.push({ name: 'ollama', passed: true, message: 'Ollama is reachable' });
  } catch (err) {
    checks.push({ name: 'ollama', passed: false, message: `Ollama connection failed: ${err.message}` });
    if (opts.json) {
      output('json', { passed: false, checks });
    } else {
      console.log(`FAIL: Ollama - ${err.message}`);
    }
    return 1;
  }

  const embeddingModelAvailable = await checkOllamaModel(config.ollama_url, config.embedding_model);
  if (!embeddingModelAvailable) {
    checks.push({ name: 'embedding_model', passed: false, message: `Model ${config.embedding_model} not pulled. Run: ollama pull ${config.embedding_model}` });
    if (opts.json) {
      output('json', { passed: false, checks });
    } else {
      console.log(`FAIL: Embedding model ${config.embedding_model} not pulled. Run: ollama pull ${config.embedding_model}`);
    }
    return 1;
  }
  checks.push({ name: 'embedding_model', passed: true, message: `${config.embedding_model} is available` });

  const chatModelAvailable = await checkOllamaModel(config.ollama_url, config.chat_model);
  if (!chatModelAvailable) {
    checks.push({ name: 'chat_model', passed: false, message: `Model ${config.chat_model} not pulled. Run: ollama pull ${config.chat_model}` });
    if (opts.json) {
      output('json', { passed: false, checks });
    } else {
      console.log(`FAIL: Chat model ${config.chat_model} not pulled. Run: ollama pull ${config.chat_model}`);
    }
    return 1;
  }
  checks.push({ name: 'chat_model', passed: true, message: `${config.chat_model} is available` });

  if (opts.json) {
    output('json', { passed: true, checks });
  } else {
    console.log('All checks passed:');
    checks.forEach(c => console.log(`  ✓ ${c.message}`));
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

  console.log('Creating default config at ~/.openbrain/config.json');
  console.log(`  database_url: ${defaultConfig.database_url}`);
  console.log(`  ollama_url: ${defaultConfig.ollama_url}`);
  console.log(`  embedding_model: ${defaultConfig.embedding_model}`);
  console.log(`  chat_model: ${defaultConfig.chat_model}`);

  saveConfig(defaultConfig);
  console.log('Config created. Edit ~/.openbrain/config.json to customize.');
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

program.parse();