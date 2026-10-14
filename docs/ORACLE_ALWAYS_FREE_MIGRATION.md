# Sahbi Browser — Oracle Cloud Always Free migration checklist

Status: PREPARATION ONLY. Not yet deployed. No changes to the existing Railway project or attached volumes.

## Evidence and decision
- Railway project `sahbi-ai-cloud` hosts Sahbi Browser 2.1 on branch `forms-2.1`. Its services currently have **no active deployments**; Railway sent the owner a trial-expired email on 2026-10-13.
- Historical Railway volumes have not been deleted; **do not assume** they can be automatically mounted on another provider.
- Render Free sleeps after 15 minutes and loses local filesystem state: unsuitable for a persistent OAuth browser.
- GCP e2-micro has roughly 1GB RAM: insufficient headroom for reliable Chromium + Node in this architecture.
- Oracle Cloud Always Free Ampere A1 is the recommended *candidate*, with up to **2 OCPUs and 12 GB RAM** in published Always Free quota (subject to eligibility, regional capacity, inactivity reclaim and account verification). Check current Oracle pricing and region before creating anything.
- Source: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- **Do not create a Pay As You Go upgrade, pay for a VM, or store card numbers in repo or ChatGPT.** Set budget alerts; Oracle may need an identity/payment verification to open a free account.

## Pre-deployment gate
1. User creates/verifies their OCI account themselves; select an Always Free eligible region and A1 shape. Confirm the allocation price is exactly zero **before provisioning**.
2. Validate ARM64 compatibility of Playwright/Chromium for the pinned version, **including container base image availability**. Current `Dockerfile` uses `mcr.microsoft.com/playwright:v1.63.0-noble`; do not assume this image supports `linux/arm64`. Try a disposable build and browser launch test first.
3. On ARM Ubuntu VM, another candidate is system `chromium` or ARM64 Playwright Chromium with `SAHBI_EXECUTABLE_PATH`, supported by `src/session.js`; test that the binary starts and can open a harmless public site before enabling OAuth.
4. Create a new persistent disk directory `/srv/sahbi/data/profile` owned by a dedicated unprivileged user; mount or bind it as `SAHBI_PROFILE_DIR`. Never put profiles on ephemeral /tmp.
5. Run the Node MCP service bound only to `127.0.0.1:8080` (or a private firewall-restricted socket), fronted by Caddy/Nginx over HTTPS with a valid certificate. Restrict inbound public ports to 443 and optionally SSH from the administrator's IP. Do not publish a raw Chrome CDP endpoint.
6. Set `SAHBI_PUBLIC_BASE_URL=https://<approved-hostname>`. OAuth discovery/callback needs stable HTTPS origin. Keep PIN/bootstrap secret and refresh tokens private; use filesystem permissions 0600 or an OS secret facility, not GitHub files or shell history.
7. Start as a managed `systemd` service with restart-on-failure and resource limits. Test `GET /health`, OAuth login, MCP tool `browser_info`, navigation, screenshot, file upload and takeover flow. Ensure a test run survives a restart.
8. Reconnect the existing ChatGPT Sahbi Browser plugin to the **new** HTTPS MCP endpoint. A previous plugin connection points at Railway and cannot silently follow a new hostname.
9. Only after full acceptance testing, consider exporting browser sessions. Historical Railway volumes are retained: transfer only an encrypted export under the user's control, without sharing passwords/cookies/tokens in chat. If export is unavailable, sign in anew.

## Expected limitations
- An A1 free VM can be unavailable to provision or reclaimed when idle. Always Free is **not an SLA**; 24/7 is a goal, not a guarantee.
- VM resource usage, uptime and storage must be monitored. Chromium needs ample memory and disk space; keep concurrent contexts low.
- Avoid unlimited automated navigation on third-party sites. Respect account rules, authentication prompts and manual CAPTCHA/2FA.
- No user payment/registration/deployment is performed by this checklist.

## Next decision
We need an eligible OCI tenancy and actual VM details before writing host-specific installation commands. Do not touch Railway data or current credentials until this is verified.
