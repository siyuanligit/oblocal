#!/bin/bash
# Resolves openbrain from PATH set by npm install -g
# Agents call: cli-wrapper.sh <command> --json [args]

# Note: do NOT use `set -e` — openbrain search returns exit 1 when no results
# are found, which is correct behavior, not an error.

if ! command -v openbrain &> /dev/null; then
  echo 'Error: openbrain not found in PATH. Run: npm install -g ./cli' >&2
  exit 1
fi

exec openbrain "$@"