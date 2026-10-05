# Sahbi Browser

Remote Chromium/Playwright browser service for the Sahbi project.

## Endpoints
- GET /health
- POST /api/open
- GET /api/read
- GET /api/snapshot
- POST /api/click
- POST /api/fill

Set `SAHBI_TOKEN` in the hosting platform and send it as `Authorization: Bearer ...` for /api routes.

V1 uses headless Chromium. Persistent storage and MCP transport are the next steps after validating the host.


Deployment refresh: public repository enabled for Blitz build.
