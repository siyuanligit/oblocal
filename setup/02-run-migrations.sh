#!/bin/bash
echo "Running schema migrations..."
docker compose exec -T postgres psql -U postgres -d openbrain -f /schema/001-thoughts.sql
docker compose exec -T postgres psql -U postgres -d openbrain -f /schema/002-match-thoughts.sql
docker compose exec -T postgres psql -U postgres -d openbrain -f /schema/003-upsert-thought.sql
docker compose exec -T postgres psql -U postgres -d openbrain -f /schema/004-backfill-embeddings.sql
echo "Migrations complete. Verify with: docker compose exec postgres psql -U postgres -d openbrain -c '\dt'"
