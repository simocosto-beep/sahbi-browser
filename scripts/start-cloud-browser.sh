#!/usr/bin/env bash
set -euo pipefail
cd /workspaces/sahbi-browser

mkdir -p .data/profile

export DISPLAY=:99
export SAHBI_CDP_URL="http://127.0.0.1:9222"
export SAHBI_PUBLIC_BASE_URL="${SAHBI_PUBLIC_BASE_URL:-https://${CODESPACE_NAME}-8080.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}}"
export SAHBI_NOVNC_URL="${SAHBI_NOVNC_URL:-https://${CODESPACE_NAME}-6080.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}/vnc.html?autoconnect=1&resize=remote&path=websockify}"

pkill -f "Xvfb :99" 2>/dev/null || true
pkill -f "x11vnc" 2>/dev/null || true
pkill -f "websockify" 2>/dev/null || true
pkill -f "fluxbox" 2>/dev/null || true
pkill -f "node src/server.js" 2>/dev/null || true

CHROME="$(node -e 'import("playwright").then(({chromium})=>console.log(chromium.executablePath()))')"
pkill -f "$CHROME" 2>/dev/null || true
pkill -f "remote-debugging-port=9222" 2>/dev/null || true
rm -f .data/profile/SingletonLock .data/profile/SingletonCookie .data/profile/SingletonSocket 2>/dev/null || true

nohup Xvfb :99 -screen 0 1440x900x24 -ac +extension RANDR > /tmp/sahbi-xvfb.log 2>&1 &
sleep 1
nohup fluxbox > /tmp/sahbi-fluxbox.log 2>&1 &

nohup "$CHROME"   --remote-debugging-address=127.0.0.1   --remote-debugging-port=9222   --user-data-dir="/workspaces/sahbi-browser/.data/profile"   --no-sandbox   --disable-dev-shm-usage   --no-first-run   --no-default-browser-check   --window-size=1440,900   about:blank > /tmp/sahbi-chromium.log 2>&1 &

nohup x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -localhost -quiet > /tmp/sahbi-x11vnc.log 2>&1 &
WEBSOCKIFY_BIN="$(command -v websockify || true)"
if [ -z "$WEBSOCKIFY_BIN" ] && [ -x /usr/bin/websockify ]; then
  WEBSOCKIFY_BIN=/usr/bin/websockify
fi
if [ -z "$WEBSOCKIFY_BIN" ]; then
  echo "websockify is missing. Run: sudo apt-get install -y websockify python3-websockify" >&2
  exit 1
fi
NOVNC_WEB=""
for d in /usr/share/novnc /usr/share/novnc/ /usr/share/novnc/web /opt/novnc; do
  if [ -f "$d/vnc.html" ]; then NOVNC_WEB="$d"; break; fi
done
if [ -z "$NOVNC_WEB" ]; then
  echo "noVNC web root not found. Install package: apt-get install -y novnc" >&2
  exit 1
fi
nohup "$WEBSOCKIFY_BIN" --web="$NOVNC_WEB" 6080 127.0.0.1:5900 > /tmp/sahbi-novnc.log 2>&1 &

for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
  echo "Chromium CDP did not start. See /tmp/sahbi-chromium.log" >&2
  exit 1
fi

echo "Chromium visible session ready on DISPLAY :99"
echo "noVNC listening on port 6080"
echo "Starting Sahbi Browser MCP on port ${PORT:-8080}"

# GitHub Codespaces resets public forwarded ports to private after a restart.
# Retry the official GitHub CLI command in the background so Sahbi becomes
# reachable again without requiring the Ports panel each time.
(
  if command -v gh >/dev/null 2>&1 && [ -n "${CODESPACE_NAME:-}" ]; then
    for i in $(seq 1 18); do
      if gh codespace ports visibility 8080:public 6080:public -c "$CODESPACE_NAME" >/tmp/sahbi-port-visibility.log 2>&1; then
        echo "Ports 8080 and 6080 are public." >> /tmp/sahbi-port-visibility.log
        exit 0
      fi
      sleep 5
    done
    echo "Could not automatically make Codespaces ports public." >> /tmp/sahbi-port-visibility.log
  fi
) &

exec npm start
