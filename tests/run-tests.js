import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CLI = 'openbrain';
const results = [];
let firstCaptureId = null;

function log(msg, status = 'INFO') {
  const ts = new Date().toISOString().split('T')[1].slice(0, 12);
  console.log(`[${ts}] [${status}] ${msg}`);
}

async function exec(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: true, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
}

async function runPhase(name, fn) {
  log(`\n=== Phase: ${name} ===`);
  try {
    await fn();
    results.push({ phase: name, status: 'PASS' });
  } catch (err) {
    log(`FAILED: ${err.message}`, 'FAIL');
    results.push({ phase: name, status: 'FAIL', error: err.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertJson(stdout, message) {
  try {
    JSON.parse(stdout);
  } catch {
    throw new Error(`${message || 'Invalid JSON'}: ${stdout.slice(0, 100)}`);
  }
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

async function phase1Infrastructure() {
  const { code, stdout } = await exec(CLI, ['doctor', '--json']);
  log(stdout);
  assert(code === 0, `doctor exited ${code}`);
  const json = parseJson(stdout);
  assert(json.passed === true, 'doctor should pass');
}

async function phase2ToolDiscovery() {
  const { code: c1, stdout: m1 } = await exec(CLI, ['--help']);
  log(m1);
  assert(c1 === 0, 'help exited non-zero');
  assert(m1.includes('openbrain'), 'help should show CLI name');

  const { code: c2, stdout: m2 } = await exec(CLI, ['init']);
  log(m2);
  assert(c2 === 0, 'init should succeed');
}

async function phase3CaptureEmbedding() {
  const r1 = await exec(CLI, ['capture', 'The sun rises in the east every morning', '--json']);
  log(r1.stdout);
  assert(r1.code === 0, `capture 1 exited ${r1.code}`);
  const j1 = parseJson(r1.stdout);
  assert(j1.id, 'should have id');
  assert(j1.content === 'The sun rises in the east every morning', 'content mismatch');
  assert(j1.embedded === true, 'should be embedded');
  firstCaptureId = j1.id;
  const id1 = j1.id;

  const r2 = await exec(CLI, ['capture', 'I prefer coffee over tea for morning energy', '--json']);
  log(r2.stdout);
  assert(r2.code === 0, `capture 2 exited ${r2.code}`);
  const j2 = parseJson(r2.stdout);
  assert(j2.id !== id1, 'second capture should get different id');

  const r3 = await exec(CLI, ['list', '--json', '--limit', '10']);
  log(r3.stdout);
  const j3 = parseJson(r3.stdout);
  assert(j3.count === 2, `list should show 2, got ${j3.count}`);
  assert(!r3.stdout.includes('pending embedding'), 'no pending embeddings');

  const r4 = await exec(CLI, ['stats', '--json']);
  log(r4.stdout);
  const j4 = parseJson(r4.stdout);
  assert(j4.total_thoughts === 2, `stats should show 2, got ${j4.total_thoughts}`);
  assert(j4.pending_embeddings === 0, 'pending should be 0');
}

async function phase4Search() {
  const r1 = await exec(CLI, ['search', 'weather and morning', '--json', '--limit', '5', '--threshold', '0.7']);
  log(r1.stdout);
  assert(r1.code === 0, 'search should exit 0');
  const j1 = parseJson(r1.stdout);
  assert(j1.count >= 1, 'should find at least 1 result');
  assert(j1.results[0].similarity > 0.7, 'similarity should exceed threshold');

  const r2 = await exec(CLI, ['search', 'machine learning neural networks', '--json', '--limit', '5', '--threshold', '0.7']);
  log(r2.stdout);
  assert(r2.code === 0, 'search should exit 0 even with no results');
  const j2 = parseJson(r2.stdout);
  assert(j2.count === 0, 'should have no results');
  assert(j2.results.length === 0, 'results array should be empty');

  const r3 = await exec(CLI, ['search', 'software programming code', '--json', '--threshold', '0.3', '--limit', '5']);
  log(r3.stdout);
  assert(r3.code === 0, 'search with low threshold should succeed');

  const r4 = await exec(CLI, ['search', 'nonexistent query xyz123', '--json']);
  log(r4.stdout);
  assert(r4.code === 0, 'search with no results should exit 0');
}

async function phase5Deduplication() {
  const r1 = await exec(CLI, ['capture', 'The sun rises in the east every morning', '--json']);
  log(r1.stdout);
  const j1 = parseJson(r1.stdout);
  assert(j1.id === firstCaptureId, 'deduped capture should return same id');

  const r2 = await exec(CLI, ['stats', '--json']);
  log(r2.stdout);
  const j2 = parseJson(r2.stdout);
  assert(j2.total_thoughts === 2, `should still be 2, got ${j2.total_thoughts}`);
}

async function phase6Backfill() {
  const r1 = await exec(CLI, ['--backfill', '--json']);
  log(r1.stdout);
  const j1 = parseJson(r1.stdout);
  assert(typeof j1.backfilled === 'number', 'should have backfilled count');
  assert(typeof j1.remaining === 'number', 'should have remaining count');
}

async function phase10EdgeCases() {
  const r1 = await exec(CLI, ['search', '', '--json']);
  log(r1.stdout);
  assert(r1.code === 0, 'empty search should not crash');

  const r2 = await exec(CLI, ['list', '--json', '--limit', '1']);
  log(r2.stdout);
  const j2 = parseJson(r2.stdout);
  assert(j2.count === 1, 'list with limit 1 should return 1');

  const r3 = await exec(CLI, ['search', 'sun rises', '--json', '--threshold', '1.0']);
  log(r3.stdout);
  assert(r3.code === 0, 'high threshold search should exit 0');
  const j3 = parseJson(r3.stdout);
  assert(j3.count === 0, 'perfect threshold should return no results');

  const longText = 'This is a longer thought that contains multiple sentences and tries to test how the system handles longer content with various punctuation and special characters like quotes " and apostrophes \' and other edge cases';
  const r4 = await exec(CLI, ['capture', longText, '--json']);
  log(r4.stdout);
  assert(r4.code === 0, 'long content should capture successfully');
  const j4 = parseJson(r4.stdout);
  assert(j4.id, 'long content should have id');
}

async function main() {
  log('OBLocal Test Suite');

  await runPhase('Phase 1: Infrastructure', phase1Infrastructure);
  await runPhase('Phase 2: Tool Discovery', phase2ToolDiscovery);
  await runPhase('Phase 3: Capture & Embedding', phase3CaptureEmbedding);
  await runPhase('Phase 4: Search', phase4Search);
  await runPhase('Phase 5: De-duplication', phase5Deduplication);
  await runPhase('Phase 6: Backfill', phase6Backfill);
  await runPhase('Phase 10: Edge Cases', phase10EdgeCases);

  log('\n=== Summary ===');
  for (const { phase, status, error } of results) {
    const icon = status === 'PASS' ? '✓' : '✗';
    log(`${icon} ${phase}${error ? ` — ${error}` : ''}`, status === 'PASS' ? 'PASS' : 'FAIL');
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  log(`\nResults: ${passed} passed, ${failed} failed`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  log(`Fatal: ${err.message}`, 'FAIL');
  process.exit(1);
});