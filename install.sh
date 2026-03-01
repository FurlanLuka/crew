#!/bin/sh
set -e

REPO="FurlanLuka/homebrew-tap"

main() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    if [ "$OS" != "linux" ]; then
        echo "This script is for Linux. On macOS, use:"
        echo "  brew install FurlanLuka/tap/crew"
        exit 1
    fi

    case "$(uname -m)" in
        x86_64)        ARCH="amd64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *)
            echo "Unsupported architecture: $(uname -m)"
            exit 1
            ;;
    esac

    # Install system dependencies
    for dep in tmux git; do
        command -v "$dep" >/dev/null 2>&1 && continue
        echo "Installing $dep..."
        if command -v apt-get >/dev/null 2>&1; then
            sudo apt-get update -qq && sudo apt-get install -y "$dep"
        elif command -v dnf >/dev/null 2>&1; then
            sudo dnf install -y "$dep"
        elif command -v pacman >/dev/null 2>&1; then
            sudo pacman -S --noconfirm "$dep"
        else
            echo "Please install $dep manually and re-run this script."
            exit 1
        fi
    done

    # Install Node.js if missing
    if ! command -v node >/dev/null 2>&1; then
        echo "Installing Node.js..."
        if command -v apt-get >/dev/null 2>&1; then
            curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
            sudo apt-get install -y nodejs
        elif command -v dnf >/dev/null 2>&1; then
            curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
            sudo dnf install -y nodejs
        elif command -v pacman >/dev/null 2>&1; then
            sudo pacman -S --noconfirm nodejs npm
        else
            echo "Please install Node.js manually and re-run this script."
            exit 1
        fi
    fi

    # Install happy CLI if missing
    if ! command -v happy >/dev/null 2>&1; then
        echo "Installing happy CLI..."
        sudo npm install -g happy-coder
    fi

    # Resolve GitHub token for authenticated API calls
    if [ -z "$GITHUB_TOKEN" ] && command -v gh >/dev/null 2>&1; then
        GITHUB_TOKEN=$(gh auth token 2>/dev/null || true)
    fi

    AUTH_HEADER=""
    if [ -n "$GITHUB_TOKEN" ]; then
        AUTH_HEADER="Authorization: Bearer $GITHUB_TOKEN"
    fi

    # Fetch latest version
    VERSION=$(curl -fsSL ${AUTH_HEADER:+-H "$AUTH_HEADER"} "https://api.github.com/repos/$REPO/releases/latest" \
        | grep '"tag_name"' | sed 's/.*"v//' | sed 's/".*//')

    if [ -z "$VERSION" ]; then
        echo "Failed to determine latest version."
        exit 1
    fi

    URL="https://github.com/$REPO/releases/download/v${VERSION}/crew_${VERSION}_linux_${ARCH}.tar.gz"

    echo "Installing crew v${VERSION} (linux/${ARCH})..."
    TMP=$(mktemp -d)
    curl -fsSL "$URL" | tar -xz -C "$TMP"
    sudo install -m 755 "$TMP/crew" /usr/local/bin/crew
    rm -rf "$TMP"

    mkdir -p "$HOME/.crew/workspaces"
    echo "crew v${VERSION} installed successfully."
    echo "Run: crew help"
}

main
