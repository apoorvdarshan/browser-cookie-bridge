# Brave → Codex Cookie Sync

An experimental, local-only macOS utility with a small native control window. It transfers **cookies only** from Brave into Codex's built-in browser. Passwords, browsing history, bookmarks, autofill data, and payment information are never requested.

The utility deliberately does not edit either browser's cookie database. A small unpacked extension, installed once in both browsers, uses the supported Chromium cookies API. During a sync, cookie values pass through an authenticated `127.0.0.1` broker in memory and are cleared immediately after Codex acknowledges the import.

## Local test

Requirements: macOS and Node.js 20 or newer.

```bash
cd /Users/apoorvdarshan/brave-codex-cookie-sync
npm test
npm run check
npm pack
npx --yes ./brave-codex-cookie-sync-0.2.0.tgz install-app
```

The command builds and installs `Brave Codex Sync.app` into your user Applications folder, generates two extension folders, and opens the app. Each extension has a fixed role so data cannot accidentally flow in reverse:

The native window provides Sync now, daily scheduling, extension shortcuts, and an Open at login switch. Closing the window leaves a menu-bar helper running; use its menu to reopen the window, sync, or quit completely.

1. Brave: open `brave://extensions`, enable Developer mode, choose **Load unpacked**, and select `extension-brave`.
2. Codex: open its built-in browser, choose **Extensions → Manage extensions**, enable Developer mode, choose **Load unpacked**, and select `extension-codex`.

Keep both browsers open, then press **Sync now** in the app. You can also test the engine directly:

```bash
npx --yes ./brave-codex-cookie-sync-0.2.0.tgz sync --timeout 300
```

After confirming the manual sync works, enable the daily schedule:

```bash
npx --yes ./brave-codex-cookie-sync-0.2.0.tgz setup --hour 9 --minute 0
```

The scheduled sync does not launch or force-quit either browser. It waits up to five minutes for both installed extensions; if a browser is closed, the run times out without changing data.

`setup` copies a pinned runtime into the utility's Application Support folder. The daily job runs that copy, so an `npx` cache cleanup cannot silently replace or remove the scheduled code.

## Commands

```text
install-app [--no-open]
setup [--hour 9] [--minute 0] [--no-schedule]
sync [--timeout 300]
doctor
remove-schedule
help
```

## Security notes

- The generated extension contains a random local broker token and is created with user-only filesystem permissions. Do not share that folder.
- Cookie values are held only in broker memory during an active sync. They are not logged or persisted by this utility.
- The broker listens only on IPv4 loopback, validates the token, limits payload size, and normally runs for at most five minutes.
- The extension requests access to cookies for all sites because it mirrors Brave's complete cookie jar. Review the source before loading it.
- Anyone able to use your logged-in macOS account or modify the generated extension can potentially access browser sessions.
- Some sites bind sessions to a device or browser and may reject transferred cookies.

This project uses an unsupported integration surface. Codex updates may change extension behavior.
