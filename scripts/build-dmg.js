#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJSON = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const nodeVersion = "24.19.0";
const architecture = valueAfter("--arch") || process.arch;
const swiftArchitecture = architecture === "x64" ? "x86_64" : architecture;
if (!["arm64", "x64"].includes(architecture)) throw new Error("--arch must be arm64 or x64");

const version = packageJSON.version;
const dist = path.join(root, "dist");
const work = path.join(dist, `work-${architecture}`);
const cache = path.join(dist, "cache");
const filename = `Browser-Cookie-Bridge-${architecture}.dmg`;
const output = path.join(dist, filename);
const checksumOutput = `${output}.sha256`;
const nodeArchiveName = `node-v${nodeVersion}-darwin-${architecture}.tar.gz`;
const nodeArchive = path.join(cache, nodeArchiveName);
const nodeFolder = path.join(cache, `node-v${nodeVersion}-darwin-${architecture}`);

fs.mkdirSync(dist, { recursive: true });
fs.mkdirSync(cache, { recursive: true });
fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(output, { force: true });
fs.rmSync(checksumOutput, { force: true });
fs.mkdirSync(work, { recursive: true });

await ensureNodeRuntime();
run("swift", ["build", "-c", "release", "--arch", swiftArchitecture, "--package-path", path.join(root, "macos-app")]);
const binPath = run("swift", [
  "build", "-c", "release", "--arch", swiftArchitecture,
  "--package-path", path.join(root, "macos-app"), "--show-bin-path",
]).trim();

const app = path.join(work, "Browser Cookie Bridge.app");
const contents = path.join(app, "Contents");
const macos = path.join(contents, "MacOS");
const resources = path.join(contents, "Resources");
const runtime = path.join(resources, "runtime");
fs.mkdirSync(macos, { recursive: true });
fs.mkdirSync(resources, { recursive: true });
fs.copyFileSync(path.join(binPath, "BraveCodexSyncApp"), path.join(macos, "BraveCodexSyncApp"));
fs.chmodSync(path.join(macos, "BraveCodexSyncApp"), 0o755);
fs.copyFileSync(path.join(root, "macos-app", "Info.plist"), path.join(contents, "Info.plist"));
fs.cpSync(path.join(root, "macos-app", "Resources"), resources, { recursive: true, force: true });

for (const name of ["bin", "src", "extension-template", "node_modules"]) {
  fs.cpSync(path.join(root, name), path.join(runtime, name), { recursive: true, force: true });
}
fs.rmSync(path.join(runtime, "node_modules", ".bin"), { recursive: true, force: true });
for (const name of ["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  fs.copyFileSync(path.join(root, name), path.join(runtime, name));
}
const bundledNode = path.join(runtime, "node", "bin", "node");
const nodeEntitlements = path.join(root, "macos-app", "Node.entitlements");
fs.mkdirSync(path.dirname(bundledNode), { recursive: true });
fs.copyFileSync(path.join(nodeFolder, "bin", "node"), bundledNode);
fs.chmodSync(bundledNode, 0o755);
fs.copyFileSync(path.join(nodeFolder, "LICENSE"), path.join(runtime, "node", "LICENSE"));
fs.chmodSync(path.join(runtime, "bin", "brave-codex-cookie-sync.js"), 0o755);

const signingIdentity = process.env.MACOS_SIGNING_IDENTITY || "-";
for (const nestedBinary of [bundledNode, ...filesEndingIn(runtime, ".node")]) {
  const nestedSignArgs = ["--force", "--options", "runtime", "--sign", signingIdentity];
  if (signingIdentity !== "-") nestedSignArgs.push("--timestamp");
  if (nestedBinary === bundledNode) nestedSignArgs.push("--entitlements", nodeEntitlements);
  nestedSignArgs.push(nestedBinary);
  run("/usr/bin/codesign", nestedSignArgs);
}
const signArgs = ["--force", "--deep", "--options", "runtime", "--sign", signingIdentity];
if (signingIdentity !== "-") signArgs.push("--timestamp");
signArgs.push(app);
run("/usr/bin/codesign", signArgs);
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);

const dmgRoot = path.join(work, "dmg");
fs.mkdirSync(dmgRoot, { recursive: true });
fs.cpSync(app, path.join(dmgRoot, "Browser Cookie Bridge.app"), { recursive: true, force: true });
fs.symlinkSync("/Applications", path.join(dmgRoot, "Applications"));
run("/usr/bin/hdiutil", [
  "create", "-volname", "Browser Cookie Bridge",
  "-srcfolder", dmgRoot,
  "-ov", "-format", "UDZO",
  "-imagekey", "zlib-level=9",
  output,
]);

if (signingIdentity !== "-") {
  run("/usr/bin/codesign", ["--force", "--timestamp", "--sign", signingIdentity, output]);
}

if (process.env.NOTARIZE === "1") {
  if (signingIdentity === "-") throw new Error("NOTARIZE=1 requires MACOS_SIGNING_IDENTITY");
  const keyPath = requiredEnvironment("ASC_KEY_PATH");
  const keyID = requiredEnvironment("ASC_KEY_ID");
  const issuerID = process.env.ASC_ISSUER_ID?.trim();
  const notaryArguments = ["notarytool", "submit", output, "--key", keyPath, "--key-id", keyID];
  if (issuerID) notaryArguments.push("--issuer", issuerID);
  notaryArguments.push("--wait");
  run("/usr/bin/xcrun", notaryArguments);
  run("/usr/bin/xcrun", ["stapler", "staple", output]);
  run("/usr/bin/xcrun", ["stapler", "validate", output]);
}

const checksum = sha256(output);
fs.writeFileSync(checksumOutput, `${checksum}  ${filename}\n`);
fs.rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify({ dmg: output, checksum: checksumOutput, architecture, version }, null, 2));

async function ensureNodeRuntime() {
  const base = `https://nodejs.org/dist/v${nodeVersion}`;
  if (!fs.existsSync(nodeArchive)) await download(`${base}/${nodeArchiveName}`, nodeArchive);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expectedLine = sums.split("\n").find((line) => line.endsWith(`  ${nodeArchiveName}`));
  if (!expectedLine) throw new Error(`No official checksum found for ${nodeArchiveName}`);
  const expected = expectedLine.split(/\s+/)[0];
  if (sha256(nodeArchive) !== expected) throw new Error(`Checksum mismatch for ${nodeArchiveName}`);
  if (!fs.existsSync(nodeFolder)) {
    run("/usr/bin/tar", ["-xzf", nodeArchive, "-C", cache]);
  }
}

async function download(url, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function sha256(target) {
  return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} failed with exit code ${result.status}`);
  if (result.stdout) process.stdout.write(result.stdout);
  return result.stdout || "";
}

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function filesEndingIn(directory, suffix) {
  const matches = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...filesEndingIn(candidate, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) matches.push(candidate);
  }
  return matches;
}
