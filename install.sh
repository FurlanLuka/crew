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

    # Resolve GitHub token for authenticated API calls
    if [ -z "$GITHUB_TOKEN" ] && command -v gh >/dev/null 2>&1; then
        GITHUB_TOKEN=$(gh auth token 2>/dev/null || true)
    fi

    AUTH_HEADER=""
    if [ -n "$GITHUB_TOKEN" ]; then
        AUTH_HEADER="Authorization: Bearer $GITHUB_TOKEN"
    fi

    # Install lazygit if missing
    if ! command -v lazygit >/dev/null 2>&1; then
        echo "Installing lazygit..."
        if [ "$OS" = "darwin" ] && command -v brew >/dev/null 2>&1; then
            brew install lazygit
        elif command -v pacman >/dev/null 2>&1; then
            sudo pacman -S --noconfirm lazygit
        elif command -v apt-get >/dev/null 2>&1 && apt-cache show lazygit >/dev/null 2>&1; then
            sudo apt-get update -qq && sudo apt-get install -y lazygit
        else
            # GitHub releases fallback (Ubuntu, Fedora, macOS without brew)
            LG_VERSION=$(curl -fsSL ${AUTH_HEADER:+-H "$AUTH_HEADER"} "https://api.github.com/repos/jesseduffield/lazygit/releases/latest" \
                | grep '"tag_name"' | sed 's/.*"v//' | sed 's/".*//')
            if [ -n "$LG_VERSION" ]; then
                LG_OS=$(uname -s | tr '[:upper:]' '[:lower:]')
                LG_ARCH=$(uname -m)
                case "$LG_ARCH" in aarch64) LG_ARCH="arm64" ;; esac
                LG_URL="https://github.com/jesseduffield/lazygit/releases/download/v${LG_VERSION}/lazygit_${LG_VERSION}_${LG_OS}_${LG_ARCH}.tar.gz"
                LG_TMP=$(mktemp -d)
                curl -fsSL "$LG_URL" | tar -xz -C "$LG_TMP"
                mkdir -p "$INSTALL_DIR"
                install -m 755 "$LG_TMP/lazygit" "$INSTALL_DIR/lazygit"
                rm -rf "$LG_TMP"
            else
                echo "Failed to install lazygit — install manually: https://github.com/jesseduffield/lazygit#installation"
            fi
        fi
    fi

    # Install delta if missing (used by lazygit for side-by-side diffs)
    if ! command -v delta >/dev/null 2>&1; then
        echo "Installing delta..."
        if [ "$OS" = "darwin" ] && command -v brew >/dev/null 2>&1; then
            brew install git-delta
        elif command -v pacman >/dev/null 2>&1; then
            sudo pacman -S --noconfirm git-delta
        elif command -v dnf >/dev/null 2>&1; then
            sudo dnf install -y git-delta
        else
            # GitHub releases fallback (Ubuntu, macOS without brew)
            DELTA_VERSION=$(curl -fsSL ${AUTH_HEADER:+-H "$AUTH_HEADER"} "https://api.github.com/repos/dandavison/delta/releases/latest" \
                | grep '"tag_name"' | sed 's/.*"tag_name": "//' | sed 's/".*//')
            if [ -n "$DELTA_VERSION" ]; then
                if [ "$OS" = "darwin" ]; then
                    DELTA_TARGET="delta-${DELTA_VERSION}-aarch64-apple-darwin"
                    [ "$ARCH" = "amd64" ] && DELTA_TARGET="delta-${DELTA_VERSION}-x86_64-apple-darwin"
                else
                    DELTA_TARGET="delta-${DELTA_VERSION}-x86_64-unknown-linux-gnu"
                    [ "$ARCH" = "arm64" ] && DELTA_TARGET="delta-${DELTA_VERSION}-aarch64-unknown-linux-gnu"
                fi
                DELTA_URL="https://github.com/dandavison/delta/releases/download/${DELTA_VERSION}/${DELTA_TARGET}.tar.gz"
                DELTA_TMP=$(mktemp -d)
                curl -fsSL "$DELTA_URL" | tar -xz -C "$DELTA_TMP"
                mkdir -p "$INSTALL_DIR"
                install -m 755 "$DELTA_TMP/$DELTA_TARGET/delta" "$INSTALL_DIR/delta"
                rm -rf "$DELTA_TMP"
            else
                echo "Failed to install delta — install manually: https://github.com/dandavison/delta#installation"
            fi
        fi
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

    echo "crew v${VERSION} installed successfully."
    echo "Run: crew help"
}

main
