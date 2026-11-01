#!/usr/bin/env bash
# Push desk/ into the dev comet and commit. Usage: ./dev.sh [pier-dir] [tmux-session]
set -euo pipefail
PIER=${1:-$HOME/urbit-dev/devcomet}
SESSION=${2:-devcomet}
rsync -a --delete "$(dirname "$0")/desk/" "$PIER/sextant/"
tmux send-keys -t "$SESSION" C-u '|commit %sextant' Enter
echo "committed; watch with: tmux attach -t $SESSION"
