#!/bin/sh
set -e

REPO="FurlanLuka/crew"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

main() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$OS" in
        darwin|linux) ;;
        *)
            echo "Unsupported OS: $OS"
            exit 1
            ;;
    esac

    case "$(uname -m)" in
        x86_64)        ARCH="amd64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *)
            echo "Unsupported architecture: $(uname -m)"
            exit 1
            ;;
    esac

    # Install system dependencies (Linux only)
    if [ "$OS" = "linux" ]; then
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
    fi

    # Install happier CLI if missing
    if ! command -v happier >/dev/null 2>&1; then
        echo "Installing happier CLI..."
        npm install -g @happier-dev/cli@next 2>/dev/null || sudo npm install -g @happier-dev/cli@next
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

    URL="https://github.com/$REPO/releases/download/v${VERSION}/crew_${VERSION}_${OS}_${ARCH}.tar.gz"

    echo "Installing crew v${VERSION} (${OS}/${ARCH})..."
    TMP=$(mktemp -d)
    curl -fsSL "$URL" | tar -xz -C "$TMP"

    mkdir -p "$INSTALL_DIR"
    install -m 755 "$TMP/crew" "$INSTALL_DIR/crew"
    rm -rf "$TMP"

    mkdir -p "$HOME/.crew/workspaces"

    # Ensure INSTALL_DIR is on PATH
    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
        echo ""
        echo "Add this to your shell profile (~/.zshrc, ~/.bashrc, etc.):"
        echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    fi

    # Start happier daemon if authenticated
    if command -v happier >/dev/null 2>&1; then
        if happier auth status 2>/dev/null | grep -q "Authenticated"; then
            echo "Starting happier daemon..."
            happier daemon start 2>/dev/null || true
        else
            echo "Run 'happier auth login' to authenticate, then 'happier daemon start'."
        fi
    fi

    echo "crew v${VERSION} installed successfully."
    echo "Run: crew help"
}

main
