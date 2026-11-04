#!/bin/bash
# Opens (or reuses) the Chrome window the downloader drives.
# It has its own profile, so your normal Chrome is untouched, and it stays logged in
# to Learn.UQ / Echo360 between runs. The scripts attach to it on port 9333.
PORT=9333
PROFILE="$HOME/.lecture-player/chrome-profile"
URL="${1:-https://learn.uq.edu.au/}"

if curl -s "http://127.0.0.1:$PORT/json/version" >/dev/null; then
  echo "Browser already running on port $PORT"
  exit 0
fi
mkdir -p "$PROFILE"
nohup "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=$PORT \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  "$URL" >/dev/null 2>&1 &
for _ in $(seq 1 30); do
  curl -s "http://127.0.0.1:$PORT/json/version" >/dev/null && { echo "Browser started"; exit 0; }
  sleep 0.5
done
echo "Browser did not start" >&2
exit 1
