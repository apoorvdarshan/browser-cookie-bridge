# Browser Cookie Bridge

Local cookie and session transfer for macOS. This compact native utility transfers selected browser data between Brave, Chrome, Edge, Arc, Vivaldi, Opera, and Perplexity Comet, or into ChatGPT Codex's built-in browser. ChatGPT Codex is import-only.

- **Cookies** are enabled by default and preserve supported cookie attributes.
- **History URLs** are optional. Chromium's extension API can add URLs, but it cannot preserve the original visit times or page titles.
- **Passwords** are shown as unavailable because browser extensions cannot read Chromium's password store. Bookmarks, autofill, payment data, and iCloud Keychain are not accessed.

Browser-to-browser transfers use unpacked extensions and supported Chromium APIs. For ChatGPT Codex, the utility reads the selected local Chromium profile directly, decrypts cookies with that browser's macOS Safe Storage key, and creates a dedicated Chrome-compatible staging profile encrypted with `Chrome Safe Storage`. Codex then imports that profile through its own native browser-profile importer; the utility never writes to Codex's live cookie database.

## Local test

Requirements: macOS 13 or newer and Node.js 22.5 or newer.

```bash
cd /Users/apoorvdarshan/browser-cookie-bridge
npm test
npm run check
npm pack
npx --yes ./browser-cookie-bridge-0.22.0.tgz install-app
```

This builds and installs `Browser Cookie Bridge.app` into your user Applications folder. The app provides:

- Separate **Export from** and **Import into** pickers with large browser icons
- ChatGPT Codex available only as an import destination, represented by a paired OpenAI and Codex mark
- Persistent Cookies and History URL choices
- Manual and daily source snapshots
- Daily sync and sync when you sign in, both enabled by default on a fresh installation
- Open at login, enabled by default
- An optional menu-bar helper, off by default; closing the window keeps the app running but removes it from the Dock
- Endpoint-aware errors that identify which browser did not connect and how to recover
- A distinct partial-sync warning when individual cookies or history URLs fail

The installer generates an extension folder for every supported Chromium browser. In the app, select both endpoints, then:

1. For browser-to-browser transfers, enable Developer mode in both browsers, choose **Load unpacked**, and select each generated `extension-<browser>` folder.
2. For ChatGPT Codex, no extension is used on either side: press **Sync now**, then press **Open Codex Import…**, choose **Import…**, and select the **Browser Cookie Bridge** Chrome profile.

Only the selected endpoints respond to a transfer. For a Codex destination, both the source browser and Codex may remain open while the encrypted staging profile is prepared.

You can also control preferences and sync from the packed CLI:

```bash
npx --yes ./browser-cookie-bridge-0.22.0.tgz preferences --source brave --target codex --cookies on --history off --menu-bar off
npx --yes ./browser-cookie-bridge-0.22.0.tgz sync --timeout 300
npx --yes ./browser-cookie-bridge-0.22.0.tgz open-codex-import
npx --yes ./browser-cookie-bridge-0.22.0.tgz setup --hour 9 --minute 0
npx --yes ./browser-cookie-bridge-0.22.0.tgz enable-login-sync
```

The fixed daily sync and login sync are independent controls. Login sync runs once when you sign in, not every rolling 24 hours; the fixed daily time therefore never drifts after restarts or sleep. Neither option launches or force-quits a browser. For Codex destinations, scheduled runs refresh the encrypted staging profile; Codex intentionally keeps the final native import behind its **Import…** action.

`setup` copies a pinned runtime into the utility's Application Support folder. The daily job runs that copy, so an `npx` cache cleanup cannot silently replace or remove the scheduled code.

## Releases

Pushing a semantic version tag runs the release workflow. The tag must match the version in `package.json`, `extension-template/manifest.json`, and the macOS app's `Info.plist`.

```bash
npm run release:check
git tag v0.22.0
git push origin v0.22.0
```

After the tests pass, GitHub Actions publishes the package to npm and creates a GitHub Release with generated notes and the npm tarball attached. Pushing a normal branch or commit does not publish anything.

## Commands

```text
install-app [--no-open]
setup [--hour 9] [--minute 0] [--no-schedule]
preferences --source brave --target codex --cookies on --history off --menu-bar off
sync [--timeout 300]
open-codex-import
doctor
enable-login-sync
disable-login-sync
enable-app-login
disable-app-login
remove-schedule
help
```

Supported source IDs: `brave`, `chrome`, `edge`, `arc`, `vivaldi`, `opera`, and `comet`. Supported target IDs are the same plus `codex`. A browser cannot be both endpoints for one transfer.

## Security notes

- Generated extensions contain a random local broker token and are created with user-only filesystem permissions. Do not share those folders.
- Cookie values and history URLs are never logged. Browser-to-browser transfers hold them only in broker memory. A Codex transfer persists them in the dedicated `Browser Cookie Bridge` Chrome profile, with cookie values encrypted by Chrome's standard macOS encryption scheme.
- The broker listens only on IPv4 loopback, validates the token and extension origin, limits payload size, and normally runs for at most five minutes.
- Cookie import requires access to cookies for all sites. History import requests Chromium's history permission. Review the source before loading it.
- Anyone able to use your logged-in macOS account or modify a generated extension can potentially access browser sessions or selected history.
- Some sites bind sessions to a device or browser and may reject transferred cookies.

The Codex destination uses Codex's native Chrome profile importer rather than an extension or direct database modification. Codex updates can still change profile discovery or import behavior.
