# Browser Cookie Bridge

Local cookie and session transfer for macOS. This compact native utility transfers selected browser data between Brave, Chrome, Edge, Arc, Vivaldi, Opera, and Perplexity Comet, or into ChatGPT Codex's built-in browser. ChatGPT Codex is import-only.

- **Cookies** are enabled by default and preserve supported cookie attributes.
- **History URLs** are optional. Chromium's extension API can add URLs, but it cannot preserve the original visit times or page titles.
- **Passwords** are shown as unavailable because browser extensions cannot read Chromium's password store. Bookmarks, autofill, payment data, and iCloud Keychain are not accessed.

The utility does not edit browser databases directly. Unpacked extensions use supported Chromium APIs. During a transfer, selected data passes through an authenticated `127.0.0.1` broker in memory and is cleared after the destination acknowledges the import.

## Local test

Requirements: macOS 13 or newer and Node.js 20 or newer.

```bash
cd /Users/apoorvdarshan/browser-cookie-bridge
npm test
npm run check
npm pack
npx --yes ./browser-cookie-bridge-0.21.0.tgz install-app
```

This builds and installs `Browser Cookie Bridge.app` into your user Applications folder. The app provides:

- Separate **Export from** and **Import into** pickers with large browser icons
- ChatGPT Codex available only as an import destination, represented by a paired OpenAI and Codex mark
- Persistent Cookies and History URL choices
- Manual and daily sync
- Daily sync and sync when you sign in, both enabled by default on a fresh installation
- Open at login, enabled by default
- An optional menu-bar helper, off by default; closing the window keeps the app running but removes it from the Dock
- Endpoint-aware errors that identify which browser did not connect and how to recover
- A distinct partial-sync warning when individual cookies or history URLs fail

The installer generates an extension folder for every supported browser plus one import-only Codex folder. In the app, select both endpoints, then:

1. In the export browser, enable Developer mode, choose **Load unpacked**, and select its generated `extension-<browser>` folder.
2. Do the same in the import browser. If the destination is ChatGPT Codex, select `extension-codex` from its built-in browser's extension manager.

Only the two endpoints selected in the app respond to a transfer. Keep both open, then press **Sync now**.

You can also control preferences and sync from the packed CLI:

```bash
npx --yes ./browser-cookie-bridge-0.21.0.tgz preferences --source brave --target codex --cookies on --history off --menu-bar off
npx --yes ./browser-cookie-bridge-0.21.0.tgz sync --timeout 300
npx --yes ./browser-cookie-bridge-0.21.0.tgz setup --hour 9 --minute 0
npx --yes ./browser-cookie-bridge-0.21.0.tgz enable-login-sync
```

The fixed daily sync and login sync are independent controls. Login sync runs once when you sign in, not every rolling 24 hours; the fixed daily time therefore never drifts after restarts or sleep. Neither option launches or force-quits a browser. Each run waits up to five minutes for both installed extensions; if a browser is closed, it times out without transferring data.

`setup` copies a pinned runtime into the utility's Application Support folder. The daily job runs that copy, so an `npx` cache cleanup cannot silently replace or remove the scheduled code.

## Commands

```text
install-app [--no-open]
setup [--hour 9] [--minute 0] [--no-schedule]
preferences --source brave --target codex --cookies on --history off --menu-bar off
sync [--timeout 300]
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
- Cookie values and history URLs are held only in broker memory during an active sync. They are not logged or persisted by this utility.
- The broker listens only on IPv4 loopback, validates the token and extension origin, limits payload size, and normally runs for at most five minutes.
- Cookie import requires access to cookies for all sites. History import requests Chromium's history permission. Review the source before loading it.
- Anyone able to use your logged-in macOS account or modify a generated extension can potentially access browser sessions or selected history.
- Some sites bind sessions to a device or browser and may reject transferred cookies.

This project uses an unsupported Codex integration surface. Codex updates may change extension behavior.
