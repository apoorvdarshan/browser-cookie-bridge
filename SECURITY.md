# Security Policy

Browser Cookie Bridge handles browser cookies and signed-in sessions. Treat every cookie value, generated extension token, browser profile, and backup as sensitive credential material.

## Supported versions

Security fixes are applied to the latest published release and the current `main` branch. Older releases may not receive fixes.

| Version | Supported |
|---|---:|
| Latest release | ✅ |
| `main` | Best effort |
| Older releases | ❌ |

The latest npm/GitHub release and the current `main` branch receive security fixes under the policy above.

## Report a vulnerability privately

Do **not** open a public issue, discussion, or pull request for a suspected vulnerability.

Use GitHub's private advisory form:

**[Privately report a security vulnerability](https://github.com/apoorvdarshan/browser-cookie-bridge/security/advisories/new)**

If that form is unavailable, contact [@aporvv](https://github.com/apoorvdarshan) privately and ask for a secure reporting channel. Do not send secrets in the initial message.

Include only the minimum information needed to reproduce the problem:

- A concise description and expected security impact
- Affected Browser Cookie Bridge version or commit
- macOS version and affected source/destination browsers
- Reproduction steps using disposable test profiles
- Relevant logs with all credentials, paths, and personal data removed
- A proof of concept that contains no real cookies, sessions, tokens, or browser data

Never submit real cookie values, generated `config.js` contents, broker tokens, Codex databases, browser profiles, Keychain material, or unredacted backups.

## What counts as a security issue

Examples include:

- Cookie or history data leaving the local Mac unexpectedly
- A Browserless upload occurring without the explicit manual cloud-upload action, or leaking its API token
- Cookie values, history URLs, or broker tokens appearing in logs
- Authentication or origin-validation bypasses in the local broker
- Another local user being able to read generated configuration, backups, or transferred data
- Arbitrary file read/write or command execution through the CLI, updater, extension, or app
- Codex database corruption that bypasses backup, validation, or rollback safeguards
- Update installation from an untrusted package or version
- A browser extension gaining permissions beyond those documented by the project

General bugs, unsupported websites, expired sessions, expected browser permission prompts, and failures caused by running Codex during an import should use the normal [bug report form](https://github.com/apoorvdarshan/browser-cookie-bridge/issues/new?template=bug_report.yml), provided no sensitive data is included.

## Response process

The maintainer will aim to:

1. Acknowledge a complete report within seven days.
2. Confirm the affected surface and request any safe additional details.
3. Develop and test a fix privately when the report is valid.
4. Publish a patched release and advisory when users can update safely.
5. Credit the reporter when requested and appropriate.

Timelines may vary with severity and complexity. Please allow a reasonable remediation period before public disclosure.

## Security model and limitations

- Browser-to-browser transfers use a short-lived broker bound to IPv4 loopback. It validates a random token and the expected extension origin.
- Browserless is an optional, destination-only cloud integration. Its uploads are manual-only, require an explicit consented action, and never run from Daily sync or Sync at login.
- Browserless API tokens are stored in macOS Keychain. A short-lived adapter reads the token, removes it from the environment before temporary Chromium starts, and invokes the official CLI without exposing the token in the OS command line or app configuration. Browserless CLI telemetry is disabled by the app.
- Browserless uploads contain cookies, local storage, and IndexedDB from a temporary copy of the selected closed profile. History and saved passwords are excluded; optional domain allowlisting can narrow the capture.
- Cookie values and history URLs are not logged. Browser-to-browser payloads are held in memory.
- Generated configuration and backup files use user-only filesystem permissions.
- Release automation builds separate Apple-silicon and Intel DMGs. The updater selects the current architecture and verifies the published SHA-256 file before mounting or installing a release.
- Public DMGs are currently ad-hoc signed rather than Apple-notarized. Verify the release checksum and download only from this repository's GitHub Releases page.
- Codex imports create a consistent SQLite backup, modify a working copy, run integrity checks, and replace the destination only after validation.
- The newest 14 Codex backups are retained under `~/Library/Application Support/BraveCodexCookieSync/backups/codex`.
- OpenAI's Safe Storage key is protected by a private macOS Keychain access group. Imported Codex cookies therefore use an empty `encrypted_value` and may remain readable to software running as the same macOS user until the website refreshes them.
- Anyone controlling the signed-in macOS account can potentially access browser sessions, generated extensions, or local backups.
- Some websites bind sessions to a browser, device, IP address, or other risk signals and may invalidate transferred cookies.
- ChatGPT Codex is an unsupported direct integration. Codex updates may change database locations or schemas; Browser Cookie Bridge refuses unknown schemas rather than modifying them.

Browser Cookie Bridge is a convenience tool, not a security boundary. Transfer data only between profiles you own and trust, and keep macOS, your browsers, and the app updated.
