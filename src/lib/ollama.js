import { FALLBACK_METADATA, MAX_TOPICS, VALID_TYPES } from './constants.js';

export async function getEmbedding(text, ollamaUrl, model = 'nomic-embed-text') {
  const response = await fetch(`${ollamaUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text })
  });
  if (!response.ok) throw new Error(`Embedding failed: ${response.status}`);
  const data = await response.json();
  return data.embedding;
}

export function safeExtractMetadata(raw) {
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return FALLBACK_METADATA;
    const topics = Array.isArray(data.topics) ? data.topics.slice(0, MAX_TOPICS) : [];
    if (topics.length === 0) return FALLBACK_METADATA;
    if (!topics.every(t => typeof t === 'string')) return FALLBACK_METADATA;
    const type = typeof data.type === 'string' && VALID_TYPES.includes(data.type) ? data.type : FALLBACK_METADATA.type;
    const people = Array.isArray(data.people) ? data.people.filter(p => typeof p === 'string') : [];
    const action_items = Array.isArray(data.action_items) ? data.action_items.filter(a => typeof a === 'string') : [];
    const dates_mentioned = Array.isArray(data.dates_mentioned) ? data.dates_mentioned.filter(d => typeof d === 'string') : [];
    return { topics, type, people, action_items, dates_mentioned };
  } catch {
    return FALLBACK_METADATA;
  }
}

export async function extractMetadata(text, ollamaUrl, chatModel = 'llama3.2-mini') {
  const safeText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  try {
    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chatModel,
        stream: false,
        format: 'json',
        messages: [{
          role: 'system',
          content: `Extract metadata from the user's thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`
        }, { role: 'user', content: safeText }]
      })
    });
    if (!response.ok) throw new Error(`Metadata extraction failed: ${response.status}`);
    const data = await response.json();
    return safeExtractMetadata(data.message?.content);
  } catch {
    return FALLBACK_METADATA;
  }
}

export async function backfillPendingEmbeddings(pgPool, ollamaUrl, embeddingModel = 'nomic-embed-text') {
  const result = await pgPool.query(
    'SELECT id, content FROM thoughts WHERE needs_embedding = true AND embedding IS NULL ORDER BY created_at ASC LIMIT 50'
  );
  for (const row of result.rows) {
    try {
      const embedding = await getEmbedding(row.content, ollamaUrl, embeddingModel);
      await pgPool.query(
        'UPDATE thoughts SET embedding = $1, needs_embedding = false WHERE id = $2',
        [embedding, row.id]
      );
    } catch (err) {
      console.error(`[backfill] Failed embedding for thought ${row.id}: ${err.message}`);
    }
  }
  return result.rows.length;
}
