#!/bin/bash
# Start Docker containers (postgres + mcp server)

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
    docker compose up -d mcp
    docker compose ps
}

main() {
    local os=$(detect_os)
    echo "Detected OS: $os"
    echo "Starting containers..."

    start_containers

    echo ""
    echo "Verifying containers are healthy..."
    sleep 2
    docker compose ps | grep -E "(postgres|mcp)" | grep -q "healthy\|running" && echo "All containers running." || echo "Check status with: docker compose ps"
}

main