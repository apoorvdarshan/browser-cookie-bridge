import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appSupportDir, installedAppPath, projectRoot } from "./paths.js";

export function installApp({ home = os.homedir(), open = true } = {}) {
  if (process.platform !== "darwin") throw new Error("The desktop app supports macOS only.");

  const packagePath = path.join(projectRoot(), "macos-app");
  run("swift", ["build", "-c", "release", "--package-path", packagePath]);
  const binPath = run("swift", [
    "build",
    "-c",
    "release",
    "--package-path",
    packagePath,
    "--show-bin-path",
  ]).trim();

  const staging = path.join(appSupportDir(home), "app-build", "Browser ChatGPT Sync.app");
  const contents = path.join(staging, "Contents");
  const macos = path.join(contents, "MacOS");
  const resources = path.join(contents, "Resources");
  fs.mkdirSync(macos, { recursive: true, mode: 0o700 });
  fs.mkdirSync(resources, { recursive: true, mode: 0o700 });

  fs.copyFileSync(path.join(binPath, "BraveCodexSyncApp"), path.join(macos, "BraveCodexSyncApp"));
  fs.chmodSync(path.join(macos, "BraveCodexSyncApp"), 0o755);
  fs.copyFileSync(path.join(packagePath, "Info.plist"), path.join(contents, "Info.plist"));
  fs.cpSync(path.join(packagePath, "Resources"), resources, { recursive: true, force: true });

  run("codesign", ["--force", "--deep", "--sign", "-", staging]);

  const destination = installedAppPath(home);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(staging, destination, { recursive: true, force: true });
  const legacyDestination = path.join(home, "Applications", "Brave Codex Sync.app");
  if (legacyDestination !== destination) fs.rmSync(legacyDestination, { recursive: true, force: true });
  run("xattr", ["-dr", "com.apple.quarantine", destination], { allowFailure: true });
  if (open) run("open", [destination]);
  return destination;
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || `${command} failed with exit code ${result.status}`);
  }
  return result.stdout || "";
}
