#!/usr/bin/env bash
set -euo pipefail
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y xvfb x11vnc fluxbox novnc websockify python3-websockify
chmod +x scripts/start-cloud-browser.sh
echo "Cloud browser dependencies installed."
