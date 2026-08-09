import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBroker } from "./broker.js";
import { installConfig, installRuntime, readConfig } from "./config.js";
import {
  braveCookiePaths,
  codexCookiePaths,
  configPath,
  installedExtensionDir,
  launchAgentPath,
} from "./paths.js";
import { installSchedule, removeSchedule } from "./scheduler.js";

const HELP = `brave-codex-cookie-sync

Cookie-only local synchronization from Brave to Codex's built-in browser.

Commands:
  setup [--hour 9] [--minute 0] [--no-schedule]
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
  console.log(`Brave extension: ${installedExtensionDir(undefined, "brave")}`);
  console.log(`Codex extension: ${installedExtensionDir(undefined, "codex")}`);
  console.log("Brave: brave://extensions → Developer mode → Load unpacked → choose the Brave extension folder");
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
    timeoutMs: seconds * 1000,
    onEvent(event) {
      if (event.type === "listening") {
        console.log(`Waiting for Brave and Codex extensions on 127.0.0.1:${event.port}…`);
      } else if (event.type === "source") {
        console.log(`Received ${event.count} cookies from Brave in memory.`);
      } else if (event.type === "complete") {
        console.log(`Imported ${event.imported}; skipped ${event.skipped}; failed ${event.failed}.`);
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
  console.log(`Brave extension: ${status(installedExtensionDir(home, "brave"))}`);
  console.log(`Codex extension: ${status(installedExtensionDir(home, "codex"))}`);
  console.log(`Daily schedule: ${status(launchAgentPath(home))}`);
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

function existing(paths) {
  return paths.filter((candidate) => fs.existsSync(candidate));
}

function status(candidate) {
  return fs.existsSync(candidate) ? candidate : "not installed";
}

function pad(value) {
  return String(value).padStart(2, "0");
}
