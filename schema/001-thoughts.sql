CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE thoughts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content TEXT NOT NULL,
  embedding VECTOR(1536),
  metadata JSONB DEFAULT '{}'::jsonb,
  content_fingerprint TEXT,
  source TEXT DEFAULT 'local',
  needs_embedding BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON thoughts USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON thoughts USING gin (metadata);
CREATE INDEX ON thoughts (created_at DESC);
CREATE INDEX ON thoughts (needs_embedding) WHERE needs_embedding = true;

CREATE UNIQUE INDEX idx_thoughts_fingerprint ON thoughts (content_fingerprint) WHERE content_fingerprint IS NOT NULL;

CREATE OR REPLACE FUNCTION update_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

CREATE TRIGGER thoughts_updated_at BEFORE UPDATE ON thoughts FOR EACH ROW EXECUTE FUNCTION update_updated_at();