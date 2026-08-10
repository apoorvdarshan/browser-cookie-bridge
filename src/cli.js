import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installApp } from "./app-installer.js";
import { createBroker } from "./broker.js";
import {
  CODEX_RUNNING_ERROR,
  directImportToCodex,
  isCodexRunning,
} from "./codex-direct-import.js";
import { readChromiumProfile } from "./chromium-reader.js";
import { installConfig, installRuntime, readConfig, updatePreferences } from "./config.js";
import {
  braveCookiePaths,
  appLoginLaunchAgentPath,
  codexCookiePaths,
  configPath,
  installedAppPath,
  installedExtensionDir,
  launchAgentPath,
  loginSyncLaunchAgentPath,
  SOURCE_BROWSERS,
  TARGET_BROWSERS,
} from "./paths.js";
import {
  installAppLogin,
  installLoginSync,
  installSchedule,
  removeAppLogin,
  removeLoginSync,
  removeSchedule,
} from "./scheduler.js";

const HELP = `browser-cookie-bridge

Local cookie and session transfer between Chromium browsers and into ChatGPT Codex.

Commands:
  setup [--hour 9] [--minute 0] [--no-schedule]
  install-app [--no-open]
  preferences --source brave --target codex --cookies on --history off --menu-bar off
  sync [--timeout 300]
  doctor
  enable-login-sync
  disable-login-sync
  enable-app-login
  disable-app-login
  remove-schedule
  help
`;

export async function main(argv) {
  const [command = "help", ...args] = argv;
  switch (command) {
    case "setup":
      return setup(args);
    case "sync":
      return sync(args);
    case "install-app":
      return installDesktopApp(args);
    case "preferences":
      return preferences(args);
    case "doctor":
      return doctor();
    case "enable-login-sync":
      return enableLoginSync();
    case "disable-login-sync":
      return disableLoginSync();
    case "enable-app-login":
      return setAppLogin(true);
    case "disable-app-login":
      return setAppLogin(false);
    case "remove-schedule":
      return remove();
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

function preferences(args) {
  const existing = readConfig();
  const config = updatePreferences({
    cookies: booleanFlag(args, "--cookies", existing.imports?.cookies !== false),
    history: booleanFlag(args, "--history", existing.imports?.history === true),
    sourceBrowser: stringFlag(args, "--source", existing.sourceBrowser || "brave"),
    targetBrowser: stringFlag(args, "--target", existing.targetBrowser || "codex"),
    menuBar: booleanFlag(args, "--menu-bar", existing.ui?.menuBar === true),
    openAtLogin: booleanFlag(args, "--open-at-login", existing.ui?.openAtLogin !== false),
  });
  console.log(
    `Saved: source=${config.sourceBrowser}, target=${config.targetBrowser}, cookies=${config.imports.cookies ? "on" : "off"}, history=${config.imports.history ? "on" : "off"}, menu-bar=${config.ui.menuBar ? "on" : "off"}, open-at-login=${config.ui.openAtLogin ? "on" : "off"}`,
  );
}

function installDesktopApp(args) {
  assertMacOS();
  const firstInstall = !fs.existsSync(configPath());
  const runtime = installRuntime();
  const existing = fs.existsSync(configPath()) ? readConfig() : null;
  const config = installConfig({
    hour: existing?.schedule?.hour ?? 9,
    minute: existing?.schedule?.minute ?? 0,
  });
  console.log("Building the native macOS app…");
  const destination = installApp({ open: !args.includes("--no-open") });
  if (config.ui.openAtLogin) {
    installAppLogin({ appPath: destination, bootstrapNow: false });
  } else {
    removeAppLogin();
  }
  if (firstInstall) {
    const cliPath = path.join(runtime, "bin", "brave-codex-cookie-sync.js");
    installSchedule({ hour: config.schedule.hour, minute: config.schedule.minute, cliPath });
    installLoginSync({ cliPath });
    console.log(`Daily sync and sync at login enabled by default at ${pad(config.schedule.hour)}:${pad(config.schedule.minute)}.`);
  }
  console.log(`Installed: ${destination}`);
  console.log("The app is available in your user Applications folder and Spotlight.");
}

function setup(args) {
  assertMacOS();
  const hour = integerFlag(args, "--hour", 9, 0, 23);
  const minute = integerFlag(args, "--minute", 0, 0, 59);
  const noSchedule = args.includes("--no-schedule");
  const runtime = installRuntime();
  const config = installConfig({ hour, minute });
  let plist = null;

  if (!noSchedule) {
    plist = installSchedule({
      hour,
      minute,
      cliPath: path.join(runtime, "bin", "brave-codex-cookie-sync.js"),
    });
  }

  console.log("Setup complete.");
  console.log(`Pinned runtime: ${runtime}`);
  if (config.targetBrowser === "codex") {
    console.log(`Source browser: ${config.sourceBrowser} (read locally; no extension required)`);
    console.log("Target integration: direct local Codex merge (Codex must be closed)");
  } else {
    console.log(`Source extension (${config.sourceBrowser}): ${installedExtensionDir(undefined, config.sourceBrowser)}`);
    console.log(`Target extension (${config.targetBrowser}): ${installedExtensionDir(undefined, config.targetBrowser)}`);
    console.log("In both browsers: open Extensions → Developer mode → Load unpacked → choose the generated extension folder");
  }
  if (plist) console.log(`Daily schedule: ${pad(hour)}:${pad(minute)} (${plist})`);
  console.log(`Broker port: 127.0.0.1:${config.port}`);
  console.log(config.targetBrowser === "codex"
    ? "Codex is backed up and validated before its local browser data is changed."
    : "Cookie values are transferred in memory and are not written to logs or disk.");
}

async function sync(args) {
  assertMacOS();
  const seconds = integerFlag(args, "--timeout", 300, 5, 3600);
  const config = readConfig();
  const isCodexTarget = (config.targetBrowser || "codex") === "codex";
  if (isCodexTarget) {
    if (isCodexRunning()) throw new Error(CODEX_RUNNING_ERROR);
    const payload = readChromiumProfile({
      browser: config.sourceBrowser || "brave",
      imports: config.imports || { cookies: true, history: false },
    });
    console.log(`Read ${payload.cookies.length} cookies and ${payload.history.length} history URLs from ${config.sourceBrowser || "brave"}.`);
    const result = directImportToCodex({
      cookies: payload.cookies,
      history: payload.history,
      codexRunning: false,
    });
    console.log(directCodexSummary(result));
    return result;
  }
  const broker = createBroker({
    token: config.token,
    port: config.port,
    imports: config.imports || { cookies: true, history: false },
    sourceBrowser: config.sourceBrowser || "brave",
    targetBrowser: config.targetBrowser || "codex",
    timeoutMs: seconds * 1000,
    onEvent(event) {
      if (event.type === "listening") {
        console.log(`Waiting for ${config.sourceBrowser || "brave"} and ${config.targetBrowser || "codex"} extensions on 127.0.0.1:${event.port}…`);
      } else if (event.type === "source") {
        console.log(`Received ${event.cookies} cookies and ${event.history} history URLs in memory.`);
      } else if (event.type === "complete") {
        console.log(
          `Cookies: ${event.imported} imported, ${event.skipped} skipped, ${event.failed} failed. History: ${event.historyImported} imported, ${event.historySkipped} skipped, ${event.historyFailed} failed.`,
        );
      }
    },
  });
  await broker.listen();
  const result = await broker.completion;
  console.log(transferSummary(result));
  return result;
}

export function directCodexSummary(result) {
  const imported = result.imported + result.historyImported;
  const skipped = result.skipped + result.historySkipped;
  const failures = result.failed + result.historyFailed;
  if (failures > 0) {
    return `Direct Codex sync completed with warnings: ${imported} imported, ${skipped} skipped, ${failures} failed. Backup: ${result.backupPath}`;
  }
  return `Direct Codex sync complete: ${imported} imported and ${skipped} skipped. Reopen Codex to use the updated sessions. Backup: ${result.backupPath}`;
}

export function transferSummary(result) {
  const failures = result.failed + result.historyFailed;
  const imported = result.imported + result.historyImported;
  const skipped = result.skipped + result.historySkipped;
  return failures > 0
    ? `Partially synced: ${imported} imported, ${skipped} skipped, ${failures} failed. Reload the destination extension and try again.`
    : `Transfer complete: ${imported} imported and ${skipped} skipped.`;
}

function doctor() {
  const home = os.homedir();
  const brave = existing(braveCookiePaths(home));
  const codex = existing(codexCookiePaths(home));
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Node: ${process.version}`);
  console.log(`Configuration: ${status(configPath(home))}`);
  const config = fs.existsSync(configPath(home)) ? readConfig(home) : null;
  const source = config?.sourceBrowser || "brave";
  const target = config?.targetBrowser || "codex";
  console.log(`Selected source: ${source}`);
  console.log(`Selected target: ${target}`);
  console.log(`Source extension: ${status(installedExtensionDir(home, source))}`);
  console.log(
    target === "codex"
      ? "Target integration: direct local Codex merge (Codex must be closed)"
      : `Target extension: ${status(installedExtensionDir(home, target))}`,
  );
  console.log(`Daily schedule: ${status(launchAgentPath(home))}`);
  console.log(`Sync at login: ${status(loginSyncLaunchAgentPath(home))}`);
  console.log(`Open app at login: ${status(appLoginLaunchAgentPath(home))}`);
  console.log(`Desktop app: ${status(installedAppPath(home))}`);
  console.log(`Brave cookie stores detected: ${brave.length}`);
  console.log(`Codex cookie stores detected: ${codex.length}`);
  for (const file of brave) console.log(`  Brave: ${file}`);
  for (const file of codex) console.log(`  Codex: ${file}`);
  console.log("No cookie names, domains, values, or encryption keys were read.");
}

function enableLoginSync() {
  assertMacOS();
  const runtime = installRuntime();
  if (!fs.existsSync(configPath())) installConfig({ hour: 9, minute: 0 });
  const plist = installLoginSync({
    cliPath: path.join(runtime, "bin", "brave-codex-cookie-sync.js"),
  });
  console.log(`Login sync enabled: ${plist}`);
  const config = readConfig();
  console.log(config.targetBrowser === "codex"
    ? "A sync starts when you sign in and updates Codex only when Codex is closed."
    : "A sync starts when you sign in and waits up to five minutes for both browser extensions.");
}

function disableLoginSync() {
  console.log(removeLoginSync() ? "Login sync disabled." : "Login sync was not enabled.");
}

function setAppLogin(enabled) {
  assertMacOS();
  const existing = readConfig();
  updatePreferences({
    sourceBrowser: existing.sourceBrowser || "brave",
    targetBrowser: existing.targetBrowser || "codex",
    cookies: existing.imports?.cookies !== false,
    history: existing.imports?.history === true,
    menuBar: existing.ui?.menuBar === true,
    openAtLogin: enabled,
  });
  if (enabled) {
    const appPath = installedAppPath();
    if (!fs.existsSync(appPath)) throw new Error("Desktop app is not installed. Run install-app first.");
    console.log(`App login enabled: ${installAppLogin({ appPath })}`);
  } else {
    removeAppLogin();
    console.log("App login disabled.");
  }
}

function remove() {
  console.log(removeSchedule() ? "Daily schedule removed." : "No daily schedule was installed.");
}

function assertMacOS() {
  if (process.platform !== "darwin") throw new Error("This release supports macOS only.");
}

function integerFlag(args, name, fallback, minimum, maximum) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function booleanFlag(args, name, fallback) {
  const value = stringFlag(args, name, fallback ? "on" : "off");
  if (!["on", "off"].includes(value)) throw new Error(`${name} must be on or off`);
  return value === "on";
}

function stringFlag(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  if (name === "--source" && !SOURCE_BROWSERS.includes(value)) {
    throw new Error(`${name} must be one of: ${SOURCE_BROWSERS.join(", ")}`);
  }
  if (name === "--target" && !TARGET_BROWSERS.includes(value)) {
    throw new Error(`${name} must be one of: ${TARGET_BROWSERS.join(", ")}`);
  }
  return value;
}

function existing(paths) {
  return paths.filter((candidate) => fs.existsSync(candidate));
}

function status(candidate) {
  return fs.existsSync(candidate) ? candidate : "not installed";
}

function pad(value) {
  return String(value).padStart(2, "0");
}
