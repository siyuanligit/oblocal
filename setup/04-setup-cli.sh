#!/bin/bash
# Check Node.js version (requires >= 18)
node --version | grep -q "^v1[8-9]\|^v[2-9]" || { echo "Node.js 18+ required"; exit 1; }
cd ../cli && npm install -g .
openbrain init  # creates ~/.openbrain/config.json (skipped if already exists)
