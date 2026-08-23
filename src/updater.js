import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  appSupportDir,
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

export async function performUpdate({ version, appPath, appPID, home = os.homedir() }) {
  const destination = validateUpdateRequest({ version, appPath, appPID, home });
  const support = appSupportDir(home);
  const resultPath = path.join(support, "update-result.json");
  let mounted = null;
  try {
    waitForProcessToExit(appPID, 30_000);
    const release = await downloadReleaseDMG({ version, architecture: process.arch, support });
    mounted = mountReleaseDMG(release.dmgPath, support);
    const sourceApp = path.join(mounted.mountPoint, "Browser Cookie Bridge.app");
    if (!fs.existsSync(sourceApp)) throw new Error("The downloaded DMG does not contain Browser Cookie Bridge.app");
    replaceAppContents(sourceApp, destination);
    installAppLogin({ appPath: destination, bootstrapNow: false });
    writeUpdateResult(resultPath, { status: "success", version });
    unmountReleaseDMG(mounted);
    mounted = null;
    fs.rmSync(release.dmgPath, { force: true });
    fs.rmSync(release.checksumPath, { force: true });
    relaunch(destination);
    return { destination, version };
  } catch (error) {
    if (mounted) unmountReleaseDMG(mounted);
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

export function releaseAssetName(version, architecture = process.arch) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) throw new Error("Invalid update version");
  if (!["arm64", "x64"].includes(architecture)) throw new Error(`Unsupported macOS architecture: ${architecture}`);
  return `Browser-Cookie-Bridge-${architecture}.dmg`;
}

export function parseChecksum(text, expectedFilename) {
  const match = text.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
  if (!match || match[2] !== expectedFilename) throw new Error("Invalid release checksum file");
  return match[1].toLowerCase();
}

async function downloadReleaseDMG({ version, architecture, support }) {
  const updates = path.join(support, "updates");
  fs.mkdirSync(updates, { recursive: true, mode: 0o700 });
  const filename = releaseAssetName(version, architecture);
  const base = `https://github.com/aopv/browser-cookie-bridge/releases/download/v${version}`;
  const dmgPath = path.join(updates, filename);
  const checksumPath = `${dmgPath}.sha256`;
  await downloadFile(`${base}/${filename}`, dmgPath);
  await downloadFile(`${base}/${filename}.sha256`, checksumPath);
  const expected = parseChecksum(fs.readFileSync(checksumPath, "utf8"), filename);
  const actual = await fileSHA256(dmgPath);
  if (actual !== expected) throw new Error("The downloaded update failed its SHA-256 verification");
  return { dmgPath, checksumPath };
}

async function downloadFile(url, target) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Browser-Cookie-Bridge-Updater" },
    redirect: "follow",
  });
  if (!response.ok || !response.body) throw new Error(`Could not download update (${response.status})`);
  const temporary = `${target}.${process.pid}.tmp`;
  const output = fs.createWriteStream(temporary, { mode: 0o600 });
  try {
    await finished(Readable.fromWeb(response.body).pipe(output));
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

async function fileSHA256(target) {
  const hash = crypto.createHash("sha256");
  const input = fs.createReadStream(target);
  input.on("data", (chunk) => hash.update(chunk));
  await finished(input);
  return hash.digest("hex");
}

function mountReleaseDMG(dmgPath, support) {
  const mountPoint = path.join(support, "updates", `mounted-${process.pid}`);
  fs.rmSync(mountPoint, { recursive: true, force: true });
  fs.mkdirSync(mountPoint, { recursive: true, mode: 0o700 });
  const result = spawnSync("/usr/bin/hdiutil", [
    "attach", dmgPath,
    "-mountpoint", mountPoint,
    "-nobrowse",
    "-readonly",
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    fs.rmSync(mountPoint, { recursive: true, force: true });
    throw new Error(result.stderr.trim() || "The update DMG could not be mounted");
  }
  return { mountPoint };
}

function unmountReleaseDMG({ mountPoint }) {
  spawnSync("/usr/bin/hdiutil", ["detach", mountPoint, "-force"], { stdio: "ignore" });
  fs.rmSync(mountPoint, { recursive: true, force: true });
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
