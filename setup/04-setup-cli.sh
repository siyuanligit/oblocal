#!/bin/bash
# Install Open Brain CLI

detect_os() {
    case "$(uname -s)" in
        Linux*) echo "linux";;
        Darwin*) echo "macos";;
        MINGW*|CYGWIN*|MSYS*) echo "windows";;
        *) echo "unsupported";;
    esac
}

check_node() {
    if ! command -v node &> /dev/null; then
        echo "Error: Node.js not found."
        echo "Install Node.js 18+ from https://nodejs.org"
        exit 1
    fi
    local version=$(node --version | sed 's/v//')
    local major=$(echo $version | cut -d. -f1)
    if [ "$major" -lt 18 ]; then
        echo "Error: Node.js 18+ required. Current version: $version"
        exit 1
    fi
    echo "Node.js version OK: $version"
}

main() {
    local os=$(detect_os)
    echo "Detected OS: $os"

    check_node

    local cli_dir="../cli"
    if [ ! -d "$cli_dir" ]; then
        cli_dir="$(dirname "$0")/../cli"
    fi

    echo "Installing CLI..."
    cd "$cli_dir" && npm install -g . && cd - > /dev/null

    echo "Running init..."
    openbrain init

    echo ""
    echo "CLI setup complete. Verify with: openbrain doctor"
}

main