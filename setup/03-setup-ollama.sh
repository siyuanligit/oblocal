#!/bin/bash
# Install Ollama (macOS/Linux)
curl -fsSL https://ollama.com/install.sh | sh

# Pull embedding model
ollama pull nomic-embed-text

# Pull chat model for metadata extraction (llama3.2-mini)
ollama pull llama3.2-mini

# Verify
ollama run nomic-embed-text "test"
