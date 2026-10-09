# Sahbi Browser 2.1

OAuth-protected MCP browser for job applications and web forms. Uses the existing
persistent Chromium engine when `SAHBI_CDP_URL` is set. Disconnecting/redeploying
this API does not close that engine's tabs. No paid browser API was added.
Hosting and ChatGPT usage are separate and are not made free by this code.

## Tools

All field targets accept one of `selector`, exact `label`, `name`, or associated
`text`. Ambiguous matches fail rather than choosing the first element.

| Tool | Additional arguments | Result |
| --- | --- | --- |
| browser_form_state | selector (optional form scope) | Labels, names, type, required, current values, options, errors, file metadata |
| browser_validate_form | selector | valid or validation_error, exact missing/invalid fields |
| browser_upload | paths **or** attachments | Attached filenames, MIME types and sizes |
| browser_download | returnBase64 (optional) | Exact server path; optionally bytes up to 5 MiB |
| browser_select | optionText **or** value | Selected option |
| browser_check / browser_uncheck | — | Verified checked state; radio uncheck is rejected |
| browser_submit | formSelector (if ambiguous), knownValuesConfirmed | submitted, blocked, validation_error, captcha_required, auth_required or failed |
| browser_session_use | domain, account | Persistent isolated profile ID |
| browser_session_reset | exact profile ID | Resets only that profile |
| browser_takeover_start | reason: login / captcha / 2fa / human_verification / human_action | Temporary private link |
| browser_takeover_end | — | Revokes links and resumes automation |

Existing navigation, read, tabs, screenshots and fill tools remain available.
Use browser_submit for submission; generic submit-button clicks and Enter are
blocked. Fill and interaction stop on detected human checks. Never use these
APIs to evade a CAPTCHA, anti-bot protection, paywall, 2FA or identity check.

## Files across ChatGPT and Railway

`paths` means paths on the **browser API server**, not paths on another machine.
`/mnt/data/file.docx` works directly when that directory is available to the API.
A remote MCP server cannot read ChatGPT's container merely from a path string.

For a ChatGPT-local file, materialize the real attachment, then run:

```
node scripts/prepare-upload.mjs /mnt/data/CV.docx > /tmp/upload-request.json
```

The helper verifies existence, size and file format. Pass the resulting
`attachments` array plus a target to `browser_upload`. It contains actual file
bytes (base64), MIME, size and basename. Do not invent paths or paste secrets.
Keep the payload private and delete it after use. A direct host-native file
attachment transport is not provided by generic MCP; this explicit relay is
required when the two filesystems differ. The API checks the bytes again and
honors the input's `accept` and `multiple` constraints. Default allowed local
root is `/mnt/data`; configure `SAHBI_UPLOAD_ROOTS` for other intended roots.
Supported upload formats: PDF, DOCX, TXT, PNG, JPEG, up to 20 MiB each and 30 MiB
per JSON request. DOCX checks include the required OOXML ZIP entries.

Downloads return a path on the browser server. For small files, use
`returnBase64:true` and write those bytes to a chosen ChatGPT-local path. With a
separate CDP engine, an inaccessible download stream falls back to an authenticated
GET of the URL that the browser actually downloaded. Blob-only remote downloads
without a transferable stream report failure; they are not falsely marked done.

## Validation and evidence

Submission revalidates immediately, including visible required markers used by
Manatal, native constraints and visible site errors. `knownValuesConfirmed:true`
is an explicit caller attestation: software cannot determine whether a supplied
name or qualification was invented. Do not set it for unknown facts.
A redirect alone does not prove success. Unconfirmed outcomes return `blocked`
with `retrySafe:false` to prevent duplicate applications.
Human-check detection uses visible controls and messages, and is conservative;
unrecognized custom widgets or site-specific validation may need an adapter.

A crashed tab is recreated at its previous URL. Other tabs and the browser
context survive. Unsaved form values and file selections are **not** recovered
automatically: inspect, refill known values, reattach the actual files, then
validate again. Local profiles persist on disk; the separate engine owns its
remote default profile. API state and OAuth files must stay on a private volume. Resetting the remote
legacy default profile requires engine maintenance and is refused by this API;
reset of the isolated domain/account profiles is supported.

## Tests

```
npm ci
npx playwright install chromium
npm test
```

`SAHBI_EXECUTABLE_PATH` can point to an existing Chromium executable. Synthetic
PDF and DOCX fixtures are copied to `/mnt/data/sahbi-test-fixtures` during tests.
The suite exercises real Chromium, native/accessibility controls, actual upload
and download, validation failures, successful local submission, a real tab crash,
restart persistence, profile isolation/reset, remote CDP detachment and OAuth MCP.

For the live Bridge regression, provide a **private** JSON containing `cv`
(an existing file path) and `fields` (verified field-name/value pairs):

```
node scripts/bridge-check.mjs /mnt/data/private-candidate.json
```

This script refuses to proceed unless the only missing required field is
`1674596` (TEFL/C1/degree). It verifies the blocked submit, crashes its own test
tab, refills it and verifies the same document block. It never supplies invented
credentials or submits the application. The real Bridge case passed on 2026-10-09
with the supplied candidate CV; candidate data is not stored in this repository.

## Deployment and privacy

Deploy the API independently from `src/browser-engine.js`. Keep the engine's CDP
port private; do not expose it publicly. Preserve existing OAuth configuration
and volume. Initial OAuth setup codes are now written to a private `.bootstrap`
file beside the OAuth store, not to logs. Existing PINs/sessions remain valid.
Raw Playwright errors, request bodies, cookies and tokens are not logged by the
API. Takeover secrets use URL fragments and request headers, never URL paths or query
strings recorded by HTTP proxies. Links expire and are uncached; input is masked
by default.
