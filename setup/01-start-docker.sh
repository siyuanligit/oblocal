#!/bin/bash
# Start Docker containers (postgres + optionally mcp server)
# Usage: ./01-start-docker.sh [--cli]
#   --cli    Skip MCP container, start postgres only

detect_os() {
    case "$(uname -s)" in
        Linux*) echo "linux";;
        Darwin*) echo "macos";;
        MINGW*|CYGWIN*|MSYS*) echo "windows";;
        *) echo "unsupported";;
    esac
}

start_containers() {
    docker compose up -d postgres
    if [ "$SKIP_MCP" != "1" ]; then
        docker compose up -d mcp
    fi
    docker compose ps
}

main() {
    local os=$(detect_os)
    echo "Detected OS: $os"

    # Parse --cli flag
    for arg in "$@"; do
        case "$arg" in
            --cli) SKIP_MCP=1 ;;
        esac
    done

    if [ "$SKIP_MCP" = "1" ]; then
        echo "Starting postgres only (CLI mode — MCP skipped)"
    else
        echo "Starting postgres + mcp (full mode)"
    fi
    echo "Starting containers..."

    start_containers

    echo ""
    echo "Verifying containers are healthy..."
    sleep 2
    docker compose ps | grep -E "(postgres|mcp)" | grep -q "healthy\|running" && echo "All containers running." || echo "Check status with: docker compose ps"
}

main "$@"