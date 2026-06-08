#!/usr/bin/env bash
# Download the Ollama engine binary for the current platform into vendor_bin/,
# so the PyInstaller spec can bundle it. Run from the repo root.
#
# NOTE: Ollama's release asset names change over time. If a download 404s, check
#       https://github.com/ollama/ollama/releases/latest and update the URL below.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p vendor_bin

OS="$(uname -s)"
case "$OS" in
  Darwin)
    # macOS CLI binary is a universal2 Mach-O (arm64 + x86_64).
    URL="https://github.com/ollama/ollama/releases/latest/download/ollama-darwin"
    echo "Downloading Ollama (macOS universal) …"
    curl -fL "$URL" -o vendor_bin/ollama
    chmod +x vendor_bin/ollama
    file vendor_bin/ollama
    ;;
  *)
    echo "This script handles macOS. For Windows the CI downloads ollama-windows-amd64.zip." >&2
    exit 1
    ;;
esac
echo "OK -> vendor_bin/ollama"
