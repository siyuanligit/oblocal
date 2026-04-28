#!/bin/bash
# Uses docker compose exec (service name, not container name) — no hardcoded container name
docker compose exec -i mcp node /app/index.js