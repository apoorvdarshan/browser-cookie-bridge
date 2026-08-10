<div align="center">

<img src="marketing/app-icon.png" width="156" alt="Browser Cookie Bridge cookie logo" />

<h1>Browser Cookie Bridge</h1>

<strong>Move cookies and signed-in sessions between browsers—locally on your Mac.</strong>

<p>Brave, Chrome, Edge, Arc, Vivaldi, Opera, and Comet · browser-to-browser transfer · import into ChatGPT Codex.</p>

<p>
  <img src="https://img.shields.io/badge/macOS-13%2B-111111?logo=apple&logoColor=white" alt="macOS 13+" />
  <img src="https://img.shields.io/badge/Swift-6-8E2735?logo=swift&logoColor=white" alt="Swift 6" />
  <img src="https://img.shields.io/badge/Node.js-22.5%2B-3C873A?logo=nodedotjs&logoColor=white" alt="Node.js 22.5+" />
  <img src="https://img.shields.io/badge/local--first-no%20cloud-C68B3C" alt="Local-first, no cloud" />
  <img src="https://img.shields.io/github/stars/apoorvdarshan/browser-cookie-bridge?logo=github&color=C68B3C" alt="GitHub stars" />
  <img src="https://img.shields.io/badge/license-MIT-3DA639" alt="MIT License" />
</p>

<p>
  <a href="#installation"><b>Install</b></a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#security--privacy">Security</a> ·
  <a href="CONTRIBUTING.md">Contribute</a> ·
  <a href="https://github.com/apoorvdarshan/browser-cookie-bridge/issues/new?template=bug_report.yml">Report a bug</a> ·
  <a href="#support">Support</a>
</p>

<p><code>npm run build:app</code></p>

<br />

<img src="marketing/product-hunt/01-overview.png" width="840" alt="Browser Cookie Bridge app preview" />

</div>

---

> **Status — local beta.** The native app and transfer engine work locally; the first public npm release has not been published yet. Importing into ChatGPT Codex is an intentionally unsupported direct integration and requires Codex to be completely closed.

## Why Browser Cookie Bridge

Signing into the same sites across several browsers is repetitive. Export files are awkward, password managers do not move active sessions, and ChatGPT Codex does not currently offer a Brave import button.

Browser Cookie Bridge gives those local browser profiles a small, native control panel. Pick where data comes from, pick where it goes, choose cookies or history, and sync. Transfers stay on the Mac you are using.

## Features

- 🍪 **Cookie and session transfer** — cookies are enabled by default, including supported domain, path, expiry, security, `SameSite`, and partition attributes.
- 🌐 **Seven Chromium browsers** — Brave, Chrome, Edge, Arc, Vivaldi, Opera, and Perplexity Comet can be sources or destinations.
- ✨ **ChatGPT Codex import** — merge selected local browser data into Codex's built-in browser; Codex is destination-only.
- 🕘 **Background automation** — sync when you sign in, at a fixed daily time, or whenever you choose.
- ◉ **Native menu-bar app** — closing the window removes the Dock icon while the helper continues running.
- 🧯 **Backup and rollback** — Codex's database is backed up, modified on a separate copy, integrity-checked, and restored if replacement fails.
- ⬆️ **Built-in updates** — automatically checks npm release metadata and can install an update and relaunch the app.
- 🔒 **Local-first** — no account, analytics, cloud service, cookie logs, or remote relay.

## What it transfers

| Data | Support | Notes |
|---|---:|---|
| **Cookies and sessions** | ✅ Default | Transfers supported cookie values and attributes |
| **History URLs** | ◐ Optional | Original visit times and page titles cannot be preserved |
| **Passwords** | — Never | Chromium extensions cannot read the browser password store |
| **Bookmarks, autofill, payments** | — Never | Not requested or accessed |
| **iCloud Keychain** | — Never | Remains completely separate |

Some websites bind sessions to a specific device or browser and may ask you to sign in again after a transfer.

## Requirements

- **macOS 13 (Ventura)+**
- **Node.js 22.5+**
- **Xcode Command Line Tools** — install with `xcode-select --install`
- A supported Chromium browser, or ChatGPT Codex as the destination

## Installation

### From source

```bash
git clone https://github.com/apoorvdarshan/browser-cookie-bridge.git
cd browser-cookie-bridge
npm test
npm run build:app
```

The final command compiles the native SwiftUI app, installs it as `~/Applications/Browser Cookie Bridge.app`, enables **Open at login**, **Sync at login**, and the **menu-bar helper**, then launches it. Daily sync stays off until you enable it.

### Via npm

The package will be installable after the first tagged release:

```bash
npx browser-cookie-bridge install-app
```

No administrator password is needed. The app is built from source on your Mac and installed in your user Applications folder.

## Setup

### Browser → ChatGPT Codex

No browser extension is needed for this path.

1. Select a source browser and **ChatGPT Codex** as the destination.
2. Quit Codex completely. Closing only its browser panel is not enough.
3. Choose **Cookies** and, optionally, **History URLs**.
4. Press **Sync now** and reopen Codex after the success message.

If Codex is open, the app blocks the transfer and tells you what to close. It never force-quits Codex.

### Browser → browser

Browser-to-browser transfers use a small unpacked extension at each selected endpoint.

1. Run `browser-cookie-bridge setup --no-schedule` or use the app's extension setup action.
2. Open the extensions page in both browsers and enable **Developer mode**.
3. Choose **Load unpacked** and select the generated `extension-<browser>` folder for each endpoint.
4. Keep both browsers open, select the same endpoints in the app, then press **Sync now**.

Generated extensions live under `~/Library/Application Support/BraveCodexCookieSync/` and contain a random, user-only local broker token. Do not share those folders.

## Usage

| Control | What it does |
|---|---|
| **Export from** | Selects the browser whose data will be read |
| **Import into** | Selects a different browser or ChatGPT Codex |
| **Cookies** | Moves cookies and supported session attributes; on by default |
| **History URLs** | Adds visited URLs without their original timestamps or titles |
| **Daily sync** | Runs at one fixed local time; off by default |
| **Sync at login** | Runs once whenever you sign in; on by default |
| **Open at login** | Starts the background app after macOS login; on by default |
| **Show in menu bar** | Keeps sync, status, updates, and support actions close at hand |
| **Check for updates** | Finds a newer npm release and offers install + relaunch |

Automation always uses the source, destination, and data choices currently saved in the app. A scheduled Codex sync safely exits without making changes when Codex is open.

## CLI

```bash
browser-cookie-bridge install-app [--no-open]
browser-cookie-bridge setup [--hour 9] [--minute 0] [--no-schedule]
browser-cookie-bridge preferences --source brave --target codex --cookies on --history off
browser-cookie-bridge sync [--timeout 300]
browser-cookie-bridge doctor
browser-cookie-bridge enable-login-sync
browser-cookie-bridge disable-login-sync
browser-cookie-bridge enable-app-login
browser-cookie-bridge disable-app-login
browser-cookie-bridge remove-schedule
```

Supported source IDs are `brave`, `chrome`, `edge`, `arc`, `vivaldi`, `opera`, and `comet`. Target IDs are the same plus `codex`. The same browser cannot be both endpoints.

## How it works

| Path | Transfer method |
|---|---|
| **Browser → browser** | Unpacked extensions connect to a short-lived broker on IPv4 loopback. Selected data stays in memory and is never written to logs. |
| **Browser → Codex** | The app reads the selected local Chromium profile, creates a consistent Codex SQLite backup, merges into a working copy, validates it, then replaces the destination atomically. |

The broker validates a random token and extension origin, limits payload size, and normally exits after five minutes. Only the endpoints selected in the app respond to a transfer.

## Security & privacy

- Cookie values and history URLs are never logged.
- Browser-to-browser data is held only in broker memory.
- Codex backups are stored with user-only permissions under `~/Library/Application Support/BraveCodexCookieSync/backups/codex`; the newest 14 are retained.
- The app refuses unknown Codex database schemas instead of guessing.
- Imported Codex rows use an empty `encrypted_value` because OpenAI's Safe Storage key is protected by a private macOS Keychain access group. Those imported rows can therefore remain readable to software running as your macOS user until the website refreshes them.
- Anyone who can use your logged-in macOS account or modify a generated extension may be able to access transferred browser sessions.

Cookies are credentials. Review the source, protect your macOS account, and transfer only between profiles you trust.

Found a vulnerability? Read [SECURITY.md](SECURITY.md) and report it privately. Do not open a public issue or include real browser data.

## Releases

Pushing a semantic version tag runs tests, validates that package and app versions match, publishes to npm, and creates a GitHub Release with the tarball attached.

```bash
npm run release:check
git tag v1.0.0
git push origin v1.0.0
```

A normal branch push does not publish anything.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, validation, privacy requirements, and pull request guidance.

## Support

If Browser Cookie Bridge is useful to you:

- ⭐ **Star** the repository
- 🐛 **[Report a bug](https://github.com/apoorvdarshan/browser-cookie-bridge/issues/new?template=bug_report.yml)** — never include cookie values or tokens
- ☕ **[Support on Ko-fi](https://ko-fi.com/apoorvdarshan)**
- 𝕏 **Follow [@apoorvdarshan](https://x.com/apoorvdarshan)**
- 🚀 Product Hunt link coming soon

Product screenshots, the transparent cookie logo, and launch artwork live in [`marketing/`](marketing/).

## Website

The product landing page, documentation overview, Privacy Policy, and Terms are live at **[cookiebridge.apoorvdarshan.com](https://cookiebridge.apoorvdarshan.com)** and live in [`web/`](web/). Preview them locally at `http://localhost:3000`:

```bash
npm run web
```

## License

[MIT](LICENSE) © 2026 [Apoorv Darshan](https://github.com/apoorvdarshan)

<sub>Not affiliated with Brave, Google, Microsoft, The Browser Company, Vivaldi, Opera, Perplexity, or OpenAI. Their names and marks belong to their respective owners.</sub>
