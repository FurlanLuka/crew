#!/bin/sh
# Runs the crew pane's tests. `claude plugin test` runs every *.test.ts under
# the plugin root, and the root is the repo, voiceos's bun tests included —
# so the mod's own files are copied out and tested alone.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
mkdir -p "$dir/.claude-plugin"
cp "$root/.claude-plugin/plugin.json" "$dir/.claude-plugin/"
cp -R "$root/hooks" "$root/types" "$root/tests" "$dir/"
cd "$dir"
claude plugin validate . >/dev/null
claude plugin test .
