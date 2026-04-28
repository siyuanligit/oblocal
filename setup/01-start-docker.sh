#!/bin/bash
docker compose up -d postgres
docker compose up -d mcp
docker compose ps  # verify both containers are healthy
