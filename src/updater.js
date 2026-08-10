import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  appSupportDir,
  installedAppPath,
  systemInstalledAppPath,
  userInstalledAppPath,
} from "./paths.js";
import { installAppLogin } from "./scheduler.js";

export function startDetachedUpdate({ version, appPath, appPID, home = os.homedir() }) {
  validateUpdateRequest({ version, appPath, appPID, home });
  const support = appSupportDir(home);
  const logs = path.join(support, "logs");
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const logPath = path.join(logs, "update.log");
  const log = fs.openSync(logPath, "a", 0o600);
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "brave-codex-cookie-sync.js");
  const child = spawn(process.execPath, [
    cliPath,
    "perform-update",
    "--version", version,
    "--app-path", appPath,
    "--app-pid", String(appPID),
  ], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  fs.closeSync(log);
  return { workerPID: child.pid, logPath };
}

export function performUpdate({ version, appPath, appPID, home = os.homedir() }) {
  const destination = validateUpdateRequest({ version, appPath, appPID, home });
  const resultPath = path.join(appSupportDir(home), "update-result.json");
  const currentUserApp = installedAppPath(home);
  try {
    waitForProcessToExit(appPID, 30_000);
    const npxPath = findNpx();
    const result = spawnSync(npxPath, [
      "--yes",
      `browser-cookie-bridge@${version}`,
      "install-app",
      "--no-open",
    ], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, npm_config_yes: "true" },
    });
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `npx exited with status ${result.status}`);
    }
    if (!fs.existsSync(currentUserApp)) throw new Error("The downloaded app was not installed");
    if (destination !== currentUserApp) replaceAppContents(currentUserApp, destination);
    installAppLogin({ appPath: destination, bootstrapNow: false });
    writeUpdateResult(resultPath, { status: "success", version });
    relaunch(destination);
    return { destination, version };
  } catch (error) {
    writeUpdateResult(resultPath, { status: "failed", version, message: error.message });
    if (fs.existsSync(destination)) relaunch(destination);
    throw error;
  }
}

function replaceAppContents(source, destination) {
  if (!fs.existsSync(destination)) throw new Error(`Installed app not found at ${destination}`);
  const sourceContents = path.join(source, "Contents");
  const destinationContents = path.join(destination, "Contents");
  const stagedContents = path.join(destination, ".Contents.update");
  const previousContents = path.join(destination, ".Contents.previous");
  fs.rmSync(stagedContents, { recursive: true, force: true });
  fs.rmSync(previousContents, { recursive: true, force: true });
  fs.cpSync(sourceContents, stagedContents, { recursive: true, force: true });
  fs.renameSync(destinationContents, previousContents);
  try {
    fs.renameSync(stagedContents, destinationContents);
    fs.rmSync(previousContents, { recursive: true, force: true });
  } catch (error) {
    if (!fs.existsSync(destinationContents) && fs.existsSync(previousContents)) {
      fs.renameSync(previousContents, destinationContents);
    }
    throw error;
  }
  spawnSync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", destination], { stdio: "ignore" });
}

export function validateUpdateRequest({ version, appPath, appPID, home = os.homedir() }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) {
    throw new Error("Invalid update version");
  }
  if (!Number.isInteger(appPID) || appPID <= 1) throw new Error("Invalid app process ID");
  const resolved = path.resolve(appPath ?? "");
  const allowed = new Set([
    path.resolve(systemInstalledAppPath()),
    path.resolve(userInstalledAppPath(home)),
  ]);
  if (!allowed.has(resolved)) throw new Error(`Refusing to replace unexpected app path: ${resolved}`);
  return resolved;
}

function findNpx() {
  const sibling = path.join(path.dirname(process.execPath), "npx");
  if (fs.existsSync(sibling)) return sibling;
  const result = spawnSync("/usr/bin/which", ["npx"], { encoding: "utf8" });
  const discovered = result.status === 0 ? result.stdout.trim() : "";
  if (!discovered || !fs.existsSync(discovered)) throw new Error("npx was not found beside the configured Node.js runtime");
  return discovered;
}

function waitForProcessToExit(pid, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (processExists(pid)) {
    if (Date.now() >= deadline) throw new Error("The previous app did not quit in time");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function relaunch(appPath) {
  const result = spawnSync("/usr/bin/open", ["-g", appPath], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "The updated app could not be relaunched");
}

function writeUpdateResult(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...value, date: new Date().toISOString() })}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}
