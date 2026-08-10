import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installApp } from "./app-installer.js";
import { createBroker } from "./broker.js";
import { installConfig, installRuntime, readConfig, updatePreferences } from "./config.js";
import {
  braveCookiePaths,
  codexCookiePaths,
  configPath,
  installedAppPath,
  installedExtensionDir,
  launchAgentPath,
  SOURCE_BROWSERS,
} from "./paths.js";
import { installSchedule, removeSchedule } from "./scheduler.js";

const HELP = `brave-codex-cookie-sync

Local browser-data synchronization from Chromium browsers to Codex's built-in browser.

Commands:
  setup [--hour 9] [--minute 0] [--no-schedule]
  install-app [--no-open]
  preferences --source brave --cookies on --history off
  sync [--timeout 300]
  doctor
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
  });
  console.log(
    `Saved: source=${config.sourceBrowser}, cookies=${config.imports.cookies ? "on" : "off"}, history=${config.imports.history ? "on" : "off"}`,
  );
}

function installDesktopApp(args) {
  assertMacOS();
  installRuntime();
  const existing = fs.existsSync(configPath()) ? readConfig() : null;
  installConfig({
    hour: existing?.schedule?.hour ?? 9,
    minute: existing?.schedule?.minute ?? 0,
  });
  console.log("Building the native macOS app…");
  const destination = installApp({ open: !args.includes("--no-open") });
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
  console.log(`Source extension (${config.sourceBrowser}): ${installedExtensionDir(undefined, config.sourceBrowser)}`);
  console.log(`Codex extension: ${installedExtensionDir(undefined, "codex")}`);
  console.log("Source browser: open its Extensions page → Developer mode → Load unpacked → choose its generated extension folder");
  console.log("Codex: built-in browser → Extensions → Manage extensions → Developer mode → Load unpacked → choose the Codex extension folder");
  if (plist) console.log(`Daily schedule: ${pad(hour)}:${pad(minute)} (${plist})`);
  console.log(`Broker port: 127.0.0.1:${config.port}`);
  console.log("Cookie values are transferred in memory and are not written to logs or disk.");
}

async function sync(args) {
  assertMacOS();
  const seconds = integerFlag(args, "--timeout", 300, 5, 3600);
  const config = readConfig();
  const broker = createBroker({
    token: config.token,
    port: config.port,
    imports: config.imports || { cookies: true, history: false },
    sourceBrowser: config.sourceBrowser || "brave",
    timeoutMs: seconds * 1000,
    onEvent(event) {
      if (event.type === "listening") {
        console.log(`Waiting for ${config.sourceBrowser || "brave"} and Codex extensions on 127.0.0.1:${event.port}…`);
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
  return broker.completion;
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
  console.log(`Selected source: ${source}`);
  console.log(`Source extension: ${status(installedExtensionDir(home, source))}`);
  console.log(`Codex extension: ${status(installedExtensionDir(home, "codex"))}`);
  console.log(`Daily schedule: ${status(launchAgentPath(home))}`);
  console.log(`Desktop app: ${status(installedAppPath(home))}`);
  console.log(`Brave cookie stores detected: ${brave.length}`);
  console.log(`Codex cookie stores detected: ${codex.length}`);
  for (const file of brave) console.log(`  Brave: ${file}`);
  for (const file of codex) console.log(`  Codex: ${file}`);
  console.log("No cookie names, domains, values, or encryption keys were read.");
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
