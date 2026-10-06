# Sahbi Browser

Private persistent browser MCP for ChatGPT.

## Endpoint
- `/mcp` — Streamable HTTP MCP
- `/health` — health check

## Features
Persistent Chromium profile, page navigation and reading, clicks/forms, tabs, screenshots, and temporary private takeover links for login/2FA/CAPTCHA.

Authentication uses OAuth with PKCE. The first authorization prints a one-time bootstrap code in Railway logs; after that the user chooses a permanent PIN.
