# Contributing to Browser Cookie Bridge

Thanks for helping improve Browser Cookie Bridge. Contributions are welcome, especially fixes that make local transfers safer, clearer, and more reliable across supported browsers.

## Before you start

- Read the [security policy](SECURITY.md) before working with cookie, broker, updater, Codex or Cursor database, or Grok Bot export code.
- Search [existing issues](https://github.com/apoorvdarshan/browser-cookie-bridge/issues) before opening a duplicate.
- Use the [bug report form](https://github.com/apoorvdarshan/browser-cookie-bridge/issues/new?template=bug_report.yml) for reproducible problems.
- For a vulnerability, follow the private reporting instructions in [SECURITY.md](SECURITY.md). Do not open a public issue.

Never include real cookie values, session tokens, browser profiles, generated extension tokens, Grok Bot `.bcbx` files, or other private browsing data in an issue, commit, fixture, screenshot, or log.

## Development requirements

- macOS 13.5 or newer
- Node.js 24 or newer
- Xcode Command Line Tools: `xcode-select --install`
- At least one supported Chromium browser for manual transfer testing
- ChatGPT Codex or Cursor only when testing the corresponding direct destination
- Grok Bot only when testing the encrypted `.bcbx` export path, using disposable cookies and never attaching a real bundle to a bot or pasting cookie values into chat

## Set up the project

```bash
git clone https://github.com/apoorvdarshan/browser-cookie-bridge.git
cd browser-cookie-bridge
npm test
npm run check
```

Build and install the native app into your user Applications folder:

```bash
npm run build:app
```

The app is installed as `~/Applications/Browser Cookie Bridge.app`. This command also creates private local configuration and extension folders under `~/Library/Application Support/BraveCodexCookieSync/`.

## Project layout

| Path | Purpose |
|---|---|
| `macos-app/` | Native SwiftUI app, app metadata, icons, and menu-bar assets |
| `src/` | Broker, browser reader, embedded-browser importer, Grok Bot export, scheduling, installer, and updater |
| `extension-template/` | Unpacked Chromium extension copied into each local endpoint folder |
| `bin/` | CLI entry point |
| `test/` | Node test suite |
| `marketing/` | Screenshots, logo, and launch artwork |
| `scripts/build-dmg.js` | Reproducible self-contained Apple-silicon or Intel DMG builder |
| `.github/` | Release workflow, issue forms, and funding metadata |

## Make a change

1. Create a focused branch from `main`.
2. Keep the change small enough to review and explain.
3. Add or update tests for behavior changes.
4. Run the validation commands below.
5. Open a pull request describing the problem, the solution, and how you tested it.

Please do not mix unrelated refactors, generated artifacts, or formatting churn into a functional change.

## Validate your work

Run both required checks:

```bash
npm test
npm run check
```

For native UI changes, also build and open the app:

```bash
npm run build:app
```

To validate self-contained distribution on the current architecture:

```bash
npm run build:dmg -- --arch arm64
```

Use `--arch x64` for the Intel artifact. The builder downloads the pinned official Node runtime, verifies Node's published checksum, builds the matching Swift architecture, ad-hoc signs the app by default, and writes a DMG plus SHA-256 file under `dist/`. Set `MACOS_SIGNING_IDENTITY` only when an authorized Developer ID identity is available. Maintainer releases also set `NOTARIZE=1` with `ASC_KEY_PATH`, `ASC_KEY_ID`, and `ASC_ISSUER_ID`; the resulting Developer ID-signed DMGs are notarized and stapled before their checksums are generated.

Check the UI in both light and dark appearances where relevant. Verify labels, keyboard focus, VoiceOver descriptions, disabled states, progress states, and error messages. Include a screenshot or short recording in the pull request for visible UI changes, but remove all private browser data first.

For transfer changes, use disposable test profiles and non-sensitive test accounts. Verify the source and destination combination you changed, plus one unaffected path. Codex or Cursor must be completely closed before testing its direct import. Grok Bot tests should create a temporary `.bcbx` file and never commit the bundle or cookie values.

### Manual check: Grok Bot prompt UI from menu-bar mode

After `npm run build:app`, confirm the Grok Bot prompt appears even when the main window was closed:

1. Open Browser Cookie Bridge, choose **Grok Bot** as the destination, and close the main window so the app stays in the menu bar.
2. From the menu-bar icon, choose **Show Browser Cookie Bridge**, click **Create transfer file**, and save a disposable `.bcbx` to `/tmp`.
3. Expect a floating **Grok Bot transfer ready** panel with Reveal file, Copy prompt, and Done; the import prompt should already be on the clipboard.
4. Repeat step 2 without reopening the main window first (trigger **Create transfer file** from the restored window or menu bar sync path you changed).
5. Run **Create transfer file** again, pick the same file, and confirm **Replace**. The `.bcbx` mtime must change and the panel (or its NSAlert fallback) must appear again with the prompt on the clipboard.
6. Force a failure (for example, temporarily point `nodePath` in `~/Library/Application Support/BraveCodexCookieSync/config.json` at a missing binary) and click **Create transfer file** again. Expect a modal error alert — never only a status-line change — and restore the config afterwards.
7. Check `~/Library/Application Support/BraveCodexCookieSync/logs/app.log` and `logs/last-sync-result.json`: every attempt logs the save-panel result, the CLI launch, its exit status and last output lines, whether the bundle was rewritten, and whether the result UI was presented. These files never contain cookie values.

## Safety rules

Changes must preserve these guarantees:

- Cookie values and history URLs are never logged.
- The Grok Bot importer must not print cookie names or values, and must remain limited to the cloud-computer import path.
- Browser-to-browser payloads remain local and are not persisted by the broker.
- Generated broker tokens and configuration files keep user-only permissions.
- Direct embedded-browser changes are made through a destination-specific backup and working copy, followed by SQLite integrity checks.
- Unknown required embedded-browser database schemas fail closed instead of being modified optimistically.
- The app never force-quits a source or destination browser.
- Passwords, bookmarks, autofill, payment data, and iCloud Keychain remain out of scope.

Do not add analytics, telemetry, remote relays, or third-party data collection without prior discussion and explicit documentation.

## Commit and pull request guidance

Use clear, imperative commit messages, for example:

```text
fix: preserve partitioned cookie attributes
docs: clarify Codex shutdown requirement
test: cover expired cookie filtering
```

A good pull request includes:

- What changed and why
- User-visible impact
- Security or privacy implications
- Exact validation performed
- Screenshots for UI changes
- Related issue links

Maintainers may ask for a smaller scope, additional tests, or manual verification with a specific browser.

## Releases

Releases are performed by maintainers. Do not create or push a version tag from a contribution branch. A release tag must match the versions in `package.json`, `extension-template/manifest.json`, and `macos-app/Info.plist`; the release workflow then runs tests, Developer ID-signs and notarizes both DMGs, publishes to npm, and creates the GitHub Release with checksums.

The release repository requires `DEVELOPER_ID_APPLICATION_P12`, `DEVELOPER_ID_APPLICATION_PASSWORD`, `DEVELOPER_ID_APPLICATION_NAME`, `ASC_PRIVATE_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `NPM_TOKEN` GitHub Actions secrets. The App Store Connect key authenticates only with Apple's notarization service; releases remain direct-download software and are not submitted to the Mac App Store.

## License

By contributing, you agree that your contribution will be licensed under the repository's [MIT License](LICENSE).
