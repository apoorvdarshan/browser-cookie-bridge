# Browser → Codex Sync

An experimental, local-only macOS utility with a compact native control window. It transfers selected browser data from Brave, Chrome, Edge, Arc, Vivaldi, or Opera into Codex's built-in browser.

- **Cookies** are enabled by default and preserve supported cookie attributes.
- **History URLs** are optional. Chromium's extension API can add URLs, but it cannot preserve the original visit times or page titles.
- **Passwords** are shown as unavailable because browser extensions cannot read Chromium's password store. Bookmarks, autofill, payment data, and iCloud Keychain are not accessed.

The utility does not edit either browser's databases. Unpacked extensions installed once in the selected source browser and Codex use supported Chromium APIs. During a sync, selected data passes through an authenticated `127.0.0.1` broker in memory and is cleared after Codex acknowledges the import.

## Local test

Requirements: macOS 13 or newer and Node.js 20 or newer.

```bash
cd /Users/apoorvdarshan/brave-codex-cookie-sync
npm test
npm run check
npm pack
npx --yes ./brave-codex-cookie-sync-0.4.0.tgz install-app
```

This builds and installs `Brave Codex Sync.app` into your user Applications folder. The app provides:

- A source picker with installed browser icons and the Codex/OpenAI app icon
- Persistent Cookies and History URL choices
- Manual and daily sync
- Optional sync when you sign in to the Mac
- Open at login
- A background menu-bar helper; closing the window does not quit it

The installer generates a source extension folder for every supported browser plus one Codex target folder. In the app, select your source browser, then:

1. Open that browser's Extensions page, enable Developer mode, choose **Load unpacked**, and select its generated `extension-<browser>` folder.
2. In Codex's built-in browser, choose **Extensions → Manage extensions**, enable Developer mode, choose **Load unpacked**, and select `extension-codex`.

Only the source selected in the app responds to a sync. Keep the selected browser and Codex open, then press **Sync now**.

You can also control preferences and sync from the packed CLI:

```bash
npx --yes ./brave-codex-cookie-sync-0.4.0.tgz preferences --source brave --cookies on --history off
npx --yes ./brave-codex-cookie-sync-0.4.0.tgz sync --timeout 300
npx --yes ./brave-codex-cookie-sync-0.4.0.tgz setup --hour 9 --minute 0
npx --yes ./brave-codex-cookie-sync-0.4.0.tgz enable-login-sync
```

The fixed daily sync and login sync are independent controls. Login sync runs once when you sign in, not every rolling 24 hours; the fixed daily time therefore never drifts after restarts or sleep. Neither option launches or force-quits a browser. Each run waits up to five minutes for both installed extensions; if a browser is closed, it times out without transferring data.

`setup` copies a pinned runtime into the utility's Application Support folder. The daily job runs that copy, so an `npx` cache cleanup cannot silently replace or remove the scheduled code.

## Commands

```text
install-app [--no-open]
setup [--hour 9] [--minute 0] [--no-schedule]
preferences --source brave --cookies on --history off
sync [--timeout 300]
doctor
enable-login-sync
disable-login-sync
remove-schedule
help
```

Supported source IDs: `brave`, `chrome`, `edge`, `arc`, `vivaldi`, and `opera`.

## Security notes

- Generated extensions contain a random local broker token and are created with user-only filesystem permissions. Do not share those folders.
- Cookie values and history URLs are held only in broker memory during an active sync. They are not logged or persisted by this utility.
- The broker listens only on IPv4 loopback, validates the token and extension origin, limits payload size, and normally runs for at most five minutes.
- Cookie import requires access to cookies for all sites. History import requests Chromium's history permission. Review the source before loading it.
- Anyone able to use your logged-in macOS account or modify a generated extension can potentially access browser sessions or selected history.
- Some sites bind sessions to a device or browser and may reject transferred cookies.

This project uses an unsupported Codex integration surface. Codex updates may change extension behavior.
