#!/bin/sh
set -e

REPO="FurlanLuka/crew"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

main() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$OS" in
        darwin|linux) ;;
        *)
            printf '%s\n' "Unsupported OS: $OS"
            exit 1
            ;;
    esac

    case "$(uname -m)" in
        x86_64)        ARCH="amd64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        *)
            printf '%s\n' "Unsupported architecture: $(uname -m)"
            exit 1
            ;;
    esac

    # Install system dependencies (Linux only)
    if [ "$OS" = "linux" ]; then
        for dep in tmux git; do
            command -v "$dep" >/dev/null 2>&1 && continue
            printf '%s\n' "Installing $dep..."
            if command -v apt-get >/dev/null 2>&1; then
                sudo apt-get update -qq && sudo apt-get install -y "$dep"
            elif command -v dnf >/dev/null 2>&1; then
                sudo dnf install -y "$dep"
            elif command -v pacman >/dev/null 2>&1; then
                sudo pacman -S --noconfirm "$dep"
            else
                printf '%s\n' "Please install $dep manually and re-run this script."
                exit 1
            fi
        done

        # Install Node.js if missing
        if ! command -v node >/dev/null 2>&1; then
            printf '%s\n' "Installing Node.js..."
            if command -v apt-get >/dev/null 2>&1; then
                curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
                sudo apt-get install -y nodejs
            elif command -v dnf >/dev/null 2>&1; then
                curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
                sudo dnf install -y nodejs
            elif command -v pacman >/dev/null 2>&1; then
                sudo pacman -S --noconfirm nodejs npm
            else
                printf '%s\n' "Please install Node.js manually and re-run this script."
                exit 1
            fi
        fi
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
        printf '%s\n' "Failed to determine latest version."
        exit 1
    fi

    URL="https://github.com/$REPO/releases/download/v${VERSION}/crew_${VERSION}_${OS}_${ARCH}.tar.gz"

    printf '%s\n' "Installing crew v${VERSION} (${OS}/${ARCH})..."
    TMP=$(mktemp -d)
    curl -fsSL "$URL" | tar -xz -C "$TMP"

    mkdir -p "$INSTALL_DIR"
    install -m 755 "$TMP/crew" "$INSTALL_DIR/crew"
    rm -rf "$TMP"

    # Allow binding to port 80 without root (Linux only)
    if [ "$OS" = "linux" ]; then
        sudo setcap 'cap_net_bind_service=+ep' "$INSTALL_DIR/crew" 2>/dev/null || true
    fi

    mkdir -p "$HOME/.crew/workspaces"

    # Ensure INSTALL_DIR is on PATH
    if ! printf '%s\n' "$PATH" | tr ':' '\n' | grep -qx "$INSTALL_DIR"; then
        printf '%s\n' ""
        printf '%s\n' "Add this to your shell profile (~/.zshrc, ~/.bashrc, etc.):"
        printf '%s\n' "  export PATH=\"$INSTALL_DIR:\$PATH\""
    fi

    printf '%s\n' "crew v${VERSION} installed successfully."
    printf '%s\n' "Run: crew help"
}

main
