#!/bin/zsh
set -u
# Override with OUT=/tmp/foo ./observe2.sh. Default lives in /tmp so frames
# never dirty the repo.
OUT="${OUT:-/tmp/codesurf-observe-frames}"
mkdir -p $OUT
S=csobs2
# Unknown -s ids fall back to createSession, so a timestamped id is a fresh
# session without colliding with "latest".
SID="observe-$(date +%Y%m%d-%H%M%S)"
echo "session id: $SID  frames: $OUT"
tmux kill-session -t $S 2>/dev/null
tmux new-session -d -s $S -x 150 -y 46 -c /Users/jkneen/Documents/GitHub/grok-cli
tmux send-keys -t $S "bun run src/index.ts -m claude-sonnet-5-claude-skills -s $SID" Enter
cap() { tmux capture-pane -t $S -p -e > "$OUT/$1.txt"; tmux capture-pane -t $S -p > "$OUT/$1.plain.txt"; }
sleep 12; cap 00-boot
tmux send-keys -t $S 'Read package.json and src/ui/feature-flags.ts. Then run bunx vitest run src/ui/components/claude-code-status-line.test.ts and wait for it. Finally tell me in two sentences which test runner is used and how many feature flags exist.'
sleep 1; cap 01-typed
tmux send-keys -t $S Enter
i=2
for n in $(seq 1 60); do
  sleep 1.5
  cap "$(printf '%02d' $i)-t$(( n * 15 / 10 ))s"
  i=$((i+1))
done
cap 99-final
tmux send-keys -t $S C-c
sleep 1
tmux send-keys -t $S C-c
sleep 1
tmux kill-session -t $S 2>/dev/null
echo done
