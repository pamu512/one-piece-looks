#!/usr/bin/env bash
# Pixel gates: the probes that check what a phone actually records.
#
# The unit suites lock the color math and geometry invariants; these probes
# drive the real client + mock server and grade pixels. `npm test` runs this
# so a green unit run can no longer skip them (review finding 2026-10-09).
#
# Boot order: mock server (:8787) -> vite (:5173, bound to 127.0.0.1) ->
# probes -> shutdown. Skips cleanly (exit 0, labeled SKIP) when the
# environment can't run it: no playwright bundle, no ffmpeg, or ports busy
# with someone else's dev stack.
set -u
cd "$(dirname "$0")/.."

fail=0
skip_reason=""

command -v ffmpeg >/dev/null 2>&1 || skip_reason="ffmpeg missing"
[ -d /tmp/opl-pw/node_modules/playwright ] || skip_reason="playwright bundle missing (/tmp/opl-pw)"
if [ -n "$skip_reason" ]; then
  echo "pixel-gates: SKIP ($skip_reason) — run probes manually: demos/probe-*.mjs"
  exit 0
fi

if curl -s --max-time 1 http://127.0.0.1:8787/health >/dev/null 2>&1 \
   && curl -s --max-time 1 http://127.0.0.1:5173/ >/dev/null 2>&1; then
  echo "pixel-gates: reusing dev stack on :8787/:5173"
  OWN_STACK=0
else
  echo "pixel-gates: booting mock server + vite"
  YOUCAM_MOCK=1 npm run dev:server >/tmp/opl-gates-server.log 2>&1 &
  SERVER_PID=$!
  (cd apps/client && npx vite --host 127.0.0.1 --port 5173 >/tmp/opl-gates-vite.log 2>&1) &
  VITE_PID=$!
  OWN_STACK=1
  for i in $(seq 1 30); do
    sleep 1
    curl -s --max-time 1 http://127.0.0.1:8787/health 2>/dev/null | grep -q '"ok":true' && \
    curl -s --max-time 1 -o /dev/null http://127.0.0.1:5173/ 2>/dev/null && break
  done
fi

cleanup() {
  [ "${OWN_STACK:-0}" = "1" ] || return 0
  kill "$SERVER_PID" "$VITE_PID" 2>/dev/null
  # tsx watch leaves a child; take the port down.
  lsof -ti :8787 | xargs kill 2>/dev/null
  lsof -ti :5173 | xargs kill 2>/dev/null
}
trap cleanup EXIT

wait_up() {
  for i in $(seq 1 30); do
    sleep 1
    curl -s --max-time 1 "$1" >/dev/null 2>&1 && return 0
  done
  return 1
}
wait_up http://127.0.0.1:8787/health || { echo "pixel-gates: server never came up"; exit 1; }
wait_up http://127.0.0.1:5173/ || { echo "pixel-gates: vite never came up"; exit 1; }

run() {
  echo "--- $1"
  if node "$1"; then
    echo "--- $1 OK"
  else
    echo "--- $1 FAILED"
    fail=1
  fi
}

run demos/probe-lip-align.mjs
run demos/probe-look-distinct.mjs

if [ "$fail" = "1" ]; then
  echo "pixel-gates: FAIL"
  exit 1
fi
echo "pixel-gates: OK"
