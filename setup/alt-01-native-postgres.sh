#!/bin/bash
set -e

echo "=========================================="
echo "Open Brain — Native PostgreSQL + pgvector"
echo "=========================================="

detect_os() {
    case "$(uname -s)" in
        Linux*) echo "linux";;
        Darwin*) echo "macos";;
        MINGW*|CYGWIN*|MSYS*) echo "windows";;
        *) echo "unsupported";;
    esac
}

install_macos() {
    if ! command -v brew &> /dev/null; then
        echo "Error: Homebrew not found. Install from https://brew.sh"
        exit 1
    fi
    echo "Installing PostgreSQL 16..."
    brew install postgresql@16
    echo "Installing pgvector..."
    brew install pgvector
    echo "Starting PostgreSQL..."
    brew services start postgresql@16
    echo "Creating database..."
    createdb openbrain 2>/dev/null || true
    echo "Enabling pgvector extension..."
    psql -d openbrain -c "CREATE EXTENSION IF NOT EXISTS vector;" || echo "Note: pgvector may need to be loaded. On macOS, you may need to addpg_vector to postgresql.conf"
}

install_linux() {
    if command -v apt-get &> /dev/null; then
        echo "Installing PostgreSQL 16 and pgvector..."
        sudo apt-get update
        sudo apt-get install -y postgresql-16 postgresql-16-pgvector
        echo "Starting PostgreSQL..."
        sudo systemctl start postgresql
        sudo systemctl enable postgresql
        echo "Creating database..."
        sudo -u postgres createdb openbrain 2>/dev/null || true
        echo "Enabling pgvector..."
        sudo -u postgres psql -d openbrain -c "CREATE EXTENSION IF NOT EXISTS vector;" || true
    elif command -v yum &> /dev/null; then
        echo "RHEL/CentOS detected. Install PostgreSQL 16 and pgvector via your package manager."
        echo "Then run: createdb openbrain && psql -d openbrain -c \"CREATE EXTENSION IF NOT EXISTS vector;\""
    else
        echo "No supported package manager found. Install PostgreSQL 16 manually."
        exit 1
    fi
}

install_windows() {
    echo "=========================================="
    echo "Windows: Docker is strongly recommended."
    echo "=========================================="
    echo ""
    echo "If you prefer native PostgreSQL:"
    echo "1. Download PostgreSQL 16 from https://www.postgresql.org/download/windows/"
    echo "2. Download pgvector from https://github.com/ankane/pgvector#windows"
    echo "3. Add pg_vector to your PostgreSQL extensions"
    echo "4. Create database: createdb openbrain"
    echo "5. Enable extension: psql -d openbrain -c \"CREATE EXTENSION IF NOT EXISTS vector;\""
    echo ""
    echo "Alternatively, use Docker (recommended): docker compose up -d"
}

main() {
    OS=$(detect_os)
    echo "Detected OS: $OS"

    case $OS in
        macos)
            install_macos
            ;;
        linux)
            install_linux
            ;;
        windows)
            install_windows
            ;;
        *)
            echo "Unsupported OS: $OS"
            exit 1
            ;;
    esac

    echo ""
    echo "=========================================="
    echo "Setup complete!"
    echo ""
    echo "Next steps:"
    echo "  1. Run migrations: cd local-version && docker compose exec -T postgres psql -U postgres -d openbrain -f /schema/001-thoughts.sql"
    echo "     (or manually connect with your native psql)"
    echo "  2. Set up Ollama: ./setup/03-setup-ollama.sh"
    echo "  3. Install CLI: ./setup/04-setup-cli.sh"
    echo "  4. Verify: openbrain doctor"
    echo "=========================================="
}

main