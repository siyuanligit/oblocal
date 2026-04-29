#!/bin/bash
# Install Ollama and pull required models

detect_os() {
    case "$(uname -s)" in
        Linux*) echo "linux";;
        Darwin*) echo "macos";;
        MINGW*|CYGWIN*|MSYS*) echo "windows";;
        *) echo "unsupported";;
    esac
}

install_ollama() {
    local os=$1
    case $os in
        macos)
            echo "Installing Ollama on macOS..."
            curl -fsSL https://ollama.com/install.sh | sh
            ;;
        linux)
            echo "Installing Ollama on Linux..."
            curl -fsSL https://ollama.com/install.sh | sh
            ;;
        windows)
            echo "Download Ollama from https://ollama.com/download"
            echo "Run the installer, then reopen your terminal."
            ;;
        *)
            echo "Unsupported OS: $os"
            exit 1
            ;;
    esac
}

main() {
    local os=$(detect_os)
    echo "Detected OS: $os"

    if command -v ollama &> /dev/null; then
        echo "Ollama already installed."
    else
        install_ollama $os
    fi

    echo "Pulling models..."
    ollama pull nomic-embed-text
    ollama pull llama3.2-mini:Q2_K

    echo "Verifying models..."
    ollama list | grep -E "(nomic-embed-text|llama3.2-mini:Q2_K)" || echo "Warning: models may still be downloading"

    echo ""
    echo "Ollama setup complete. Verify with: openbrain doctor"
}

main