#!/usr/bin/env bash
set -euo pipefail
if command -v sudo >/dev/null 2>&1 && [ "$(id -u)" -ne 0 ]; then
  APT="sudo apt-get"
else
  APT="apt-get"
fi
$APT update
DEBIAN_FRONTEND=noninteractive $APT install -y xvfb x11vnc fluxbox novnc websockify python3-websockify
chmod +x scripts/start-cloud-browser.sh
echo "Cloud browser dependencies installed."
