# Sahbi Browser on-demand — GitHub Codespaces

This is a **temporary, no-credit-card development and troubleshooting option**, not a 24/7 VPS and not a replacement for the existing ChatGPT MCP connector. No paid subscription is created.

## Start from your phone or PC
1. Sign in to GitHub with your personal account. Go to the `forms-2.1` code via this branch's PR and use **Code → Codespaces → Create codespace** on the `dev/codespaces-on-demand` branch.
2. Wait for the development container to finish installing `npm` dependencies. It uses Microsoft's Playwright image on GitHub's hosted x86-64 environment.
3. Open the integrated terminal and run:
   ```bash
   npm start
   ```
4. Keep port **8080 PRIVATE**. Check **Ports** tab, or run in another terminal:
   ```bash
   curl -sS http://localhost:8080/health
   ```
5. Stop the Codespace after a test. Do **not** copy Railway's OAuth PIN, cookie files, or sensitive user sessions into GitHub or the code repository. Use a fresh session if necessary.

## Limits
- GitHub personal accounts include free monthly compute and storage quotas. Codespaces usually stop after **30 minutes idle**, and each running session has a **12-hour maximum lifetime**.
- Running more than the included monthly quota requires paid billing; **do not add a payment method** or activate overage billing.
- Profiles in Codespaces may be retained on the Codespace volume but can be deleted when the Codespace is deleted/expired. The old Railway volumes are independent and stay untouched.
- The live ChatGPT Sahbi Browser connector still points to the expired Railway deployment. A private Codespaces port does **not** make it functional in ChatGPT. Opening a public port without hardening OAuth and verifying stable callback origins can expose your browser: **do not do it**.
- This environment is meant for testing and development, not unattended navigation, permanent persistent cloud hosting, or guaranteed availability.

## Next milestone
For a proper 24/7 Sahbi Browser, identify a trustworthy hosting source that provides an always-on virtual machine with adequate RAM, persistent storage, a public HTTPS endpoint, and an explicit no-card/no-cost contract. None has yet been verified. Don't use an anonymous "free VPS" provider for stored logins.

Official reference: https://docs.github.com/en/codespaces/troubleshooting/troubleshooting-included-usage
