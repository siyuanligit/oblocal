CREATE OR REPLACE FUNCTION backfill_pending_embeddings()
RETURNS JSONB AS $$
DECLARE
  v_pending RECORD;
  v_embedding VECTOR(1536);
  v_count INT := 0;
  v_failed INT := 0;
BEGIN
  RETURN jsonb_build_object('note', 'backfill happens in Node.js, not SQL');
END;
$$ LANGUAGE plpgsql;