#!/bin/bash
# Site Visit Logger — Claude Code launcher
# Double-click in Finder to open the project in Claude Code with a fresh
# summary of where the last session left off.

set -e

PROJECT_DIR="$HOME/Documents/dancon-site-visit-logger"

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Project directory not found at $PROJECT_DIR"
  echo "Press any key to close…"
  read -n 1
  exit 1
fi

cd "$PROJECT_DIR"

# Make sure 'claude' is on PATH for non-interactive Terminal sessions.
export PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found on PATH."
  echo "Install with: npm install -g @anthropic-ai/claude-code"
  echo "Press any key to close…"
  read -n 1
  exit 1
fi

clear
echo "▸ Site Visit Logger"
echo "▸ $(pwd)"
echo "▸ Launching Claude Code…"
echo

exec claude "Read PROGRESS.md in this directory and summarize where we left off and what needs to be done next. Be concise — bullet points are fine."
