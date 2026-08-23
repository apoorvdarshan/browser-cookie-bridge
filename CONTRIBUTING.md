# Contributing to Browser Cookie Bridge

Thanks for helping improve Browser Cookie Bridge. Contributions are welcome, especially fixes that make local transfers safer, clearer, and more reliable across supported browsers.

## Before you start

- Read the [security policy](SECURITY.md) before working with cookie, broker, updater, or Codex database code.
- Search [existing issues](https://github.com/aopv/browser-cookie-bridge/issues) before opening a duplicate.
- Use the [bug report form](https://github.com/aopv/browser-cookie-bridge/issues/new?template=bug_report.yml) for reproducible problems.
- For a vulnerability, follow the private reporting instructions in [SECURITY.md](SECURITY.md). Do not open a public issue.

Never include real cookie values, session tokens, browser profiles, generated extension tokens, or other private browsing data in an issue, commit, fixture, screenshot, or log.

## Development requirements

- macOS 13.5 or newer
- Node.js 24 or newer
- Xcode Command Line Tools: `xcode-select --install`
- At least one supported Chromium browser for manual transfer testing
- ChatGPT Codex only when testing the direct Codex destination

## Set up the project

```bash
git clone https://github.com/aopv/browser-cookie-bridge.git
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
| `src/` | Broker, browser reader, Codex importer, scheduling, installer, and updater |
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

For transfer changes, use disposable test profiles and non-sensitive test accounts. Verify the source and destination combination you changed, plus one unaffected path. Codex must be completely closed before testing a Codex import.

## Safety rules

Changes must preserve these guarantees:

- Cookie values and history URLs are never logged.
- Browser-to-browser payloads remain local and are not persisted by the broker.
- Generated broker tokens and configuration files keep user-only permissions.
- Codex changes are made through a backup and working copy, followed by SQLite integrity checks.
- Unknown Codex database schemas fail closed instead of being modified optimistically.
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
