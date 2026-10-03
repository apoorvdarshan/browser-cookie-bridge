import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  appSupportDir,
  installedAppPath,
  projectRoot,
  systemInstalledAppPath,
} from "./paths.js";

export function installApp({ home = os.homedir(), open = true, preserveSystemApp = true } = {}) {
  if (process.platform !== "darwin") throw new Error("The desktop app supports macOS only.");

  const destination = installedAppPath(home);
  const isSystemInstall = path.resolve(destination) === path.resolve(systemInstalledAppPath());
  if (isSystemInstall && preserveSystemApp) {
    console.log(`Preserving the signed installation at ${destination}`);
    console.log("Use Check for Updates in the app to install signed releases.");
    if (open) run("open", [destination]);
    return destination;
  }

  const signing = localSigningIdentity(destination);

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

  const staging = path.join(appSupportDir(home), "app-build", "Browser Cookie Bridge.app");
  const contents = path.join(staging, "Contents");
  const macos = path.join(contents, "MacOS");
  const resources = path.join(contents, "Resources");
  fs.mkdirSync(macos, { recursive: true, mode: 0o700 });
  fs.mkdirSync(resources, { recursive: true, mode: 0o700 });

  fs.copyFileSync(path.join(binPath, "BraveCodexSyncApp"), path.join(macos, "BraveCodexSyncApp"));
  fs.chmodSync(path.join(macos, "BraveCodexSyncApp"), 0o755);
  fs.copyFileSync(path.join(packagePath, "Info.plist"), path.join(contents, "Info.plist"));
  fs.cpSync(path.join(packagePath, "Resources"), resources, { recursive: true, force: true });

  console.log(signing.identity === "-"
    ? "No local signing certificate found. Ad hoc builds may require Full Disk Access again after each rebuild."
    : `Signing local app with ${signing.name || signing.identity}`);
  run("/usr/bin/codesign", ["--force", "--deep", "--timestamp=none", "--sign", signing.identity, staging]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staging]);
  if (signing.previousRequirement) {
    // TCC grants belong to the installed app's designated requirement. Verify
    // compatibility before replacing it so a missing or changed certificate
    // cannot silently discard the app's existing privacy permissions.
    run("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${signing.previousRequirement}`, staging]);
  } else if (signing.identity !== "-" && fs.existsSync(destination)) {
    console.log("Switched to a stable signing identity. Full Disk Access may need to be granted once for this identity.");
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(staging, destination, { recursive: true, force: true });
  for (const legacyName of ["Browser ChatGPT Sync.app", "Brave Codex Sync.app"]) {
    const legacyDestination = path.join(home, "Applications", legacyName);
    if (legacyDestination !== destination) fs.rmSync(legacyDestination, { recursive: true, force: true });
  }
  run("xattr", ["-dr", "com.apple.quarantine", destination], { allowFailure: true });
  if (open) run("open", [destination]);
  return destination;
}

function localSigningIdentity(destination) {
  const installed = fs.existsSync(destination)
    ? spawnSync("/usr/bin/codesign", ["-d", "-r-", "-vv", destination], { encoding: "utf8" })
    : null;
  const details = installed?.status === 0 ? `${installed.stdout || ""}\n${installed.stderr || ""}` : "";
  const authority = details.match(/^Authority=(.+)$/m)?.[1];
  const previousRequirement = authority
    ? details.match(/^(?:# )?designated => (.+)$/m)?.[1]
    : undefined;
  if (authority && !previousRequirement) {
    throw new Error("Could not read the installed app's signing requirement. The installed app was preserved.");
  }

  const identities = run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
  const available = [...identities.matchAll(/^\s*\d+\) ([A-Fa-f0-9]{40}) "([^"]+)"\s*$/gm)]
    .map((match) => ({ identity: match[1], name: match[2] }));
  const requested = process.env.MACOS_SIGNING_IDENTITY?.trim();
  let selected;
  if (requested) {
    selected = available.find(({ identity, name }) => identity.toLowerCase() === requested.toLowerCase() || name === requested)
      || { identity: requested };
  } else if (authority) {
    selected = available.find(({ name }) => name === authority);
    if (!selected) {
      throw new Error(`The installed app uses ${authority}, but that signing identity is unavailable. Restore its certificate and private key, or set MACOS_SIGNING_IDENTITY to a compatible identity. The installed app was preserved.`);
    }
  } else {
    selected = available.find(({ name }) => name.startsWith("Developer ID Application:"))
      || available.find(({ name }) => name.startsWith("Apple Development:"))
      || { identity: "-" };
  }
  return { ...selected, previousRequirement };
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || `${command} failed with exit code ${result.status}`);
  }
  return result.stdout || "";
}
